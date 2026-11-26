// @ts-check
/**
 * "Node details": the small card that opens from the IP line under the
 * current node (both home pages). Shows what the exit-address lookup
 * returned, one row per known value, with a copy button for the address and
 * a "look up again" action. Nothing here is saved or logged.
 */

import { t, currentLang } from '../i18n.js';
import { exitIpFor, refreshExitIp } from './exit-ip.js';
import { copyToClipboard } from './tray.js';
import { showNotification } from './notifications.js';
import { Bus, Events } from './events.js';

/** @typedef {import('./exit-ip.js').ExitIpInfo} ExitIpInfo */
/** @typedef {{ id: string, label: string, value: string }} DetailRow */

const TYPE_KEYS = /** @type {Record<string, string>} */ ({
    hosting: 'ndTypeHosting',
    residential: 'ndTypeResidential',
    business: 'ndTypeBusiness',
    corporate: 'ndTypeBusiness',
    cellular: 'ndTypeCellular',
    mobile: 'ndTypeCellular',
});

/**
 * A connection or IP type in the user's language when known, else as given.
 * @param {string | undefined} raw
 */
export function typeLabel(raw) {
    if (!raw) return '';
    const k = raw.trim().toLowerCase();
    // Own keys only: a provider's "constructor" is not Object's.
    const key = Object.prototype.hasOwnProperty.call(TYPE_KEYS, k) ? TYPE_KEYS[k] : '';
    return key ? t(key) : raw;
}

/**
 * A country code as the user's language names it, else the provider's name.
 * @param {ExitIpInfo} info
 * @param {string} [lang]
 */
export function countryLabel(info, lang = currentLang) {
    if (info.country) {
        try {
            const name = new Intl.DisplayNames([lang || 'en'], { type: 'region' }).of(info.country);
            if (name && name !== info.country) return name;
        } catch { /* unknown code */ }
    }
    return info.country_name || info.country || '';
}

/**
 * The compact line under the node: "IP 1.2.3.4 · 大阪, 日本" (city and
 * country, or the country alone), with the ISP as its tooltip.
 * @param {ExitIpInfo} info
 * @param {string} [lang]
 * @returns {{ ip: string, place: string, title: string }}
 */
export function exitIpSummary(info, lang = currentLang) {
    const country = countryLabel(info, lang);
    // A city-state's city is its country ("Hong Kong, 香港"): the country alone.
    const same = (/** @type {string | undefined} */ v) => !!v && v.toLowerCase() === info.city?.toLowerCase();
    const english = info.country ? countryLabel({ ...info, country_name: '' }, 'en') : '';
    const city = info.city && ![info.country_name, info.country, country, english].some(same) ? info.city : '';
    const place = [city, country].filter(Boolean).join(', ');
    return { ip: `IP ${info.ip}`, place, title: info.isp || '' };
}

/** @param {ExitIpInfo} info @param {string} lang */
function detailLocation(info, lang) {
    /** @type {string[]} */
    const parts = [];
    const local = [info.district, info.city, info.region].filter((p) => p !== info.country_name);
    for (const p of [...local, countryLabel(info, lang)]) {
        if (p && !parts.includes(p)) parts.push(p);
    }
    return parts.join(', ');
}

/** @param {string|undefined} timezone @param {string} lang @param {number} now */
function detailTimezone(timezone, lang, now) {
    if (!timezone) return '';
    try {
        const local = new Intl.DateTimeFormat(lang || 'en', { timeZone: timezone, hour: '2-digit', minute: '2-digit' }).format(now);
        return `${timezone} · ${local}`;
    } catch { return timezone; }
}

/**
 * The card's rows, leaving out every value the lookup did not return.
 * @param {ExitIpInfo} info
 * @param {{ now?: number, lang?: string }} [opts]
 * @returns {DetailRow[]}
 */
export function buildDetailRows(info, { now = Date.now(), lang = currentLang } = {}) {
    /** @type {DetailRow[]} */
    const rows = [];
    /** @param {string} id @param {string} labelKey @param {string | null | undefined} value */
    const add = (id, labelKey, value) => { if (value) rows.push({ id, label: t(labelKey), value }); };

    add('ip', 'ndIp', info.ip);
    add('location', 'ndLocation', detailLocation(info, lang));
    add('continent', 'ndContinent', info.continent_name);
    add('postal', 'ndPostal', info.postal);
    if (typeof info.latitude === 'number' && typeof info.longitude === 'number') {
        add('coords', 'ndCoords', `${info.latitude.toFixed(4)}, ${info.longitude.toFixed(4)}`);
    }
    add('timezone', 'ndTimezone', detailTimezone(info.timezone, lang, now));
    add('isp', 'ndIsp', info.isp);
    if (info.org !== info.isp) add('org', 'ndOrg', info.org);
    if (typeof info.asn === 'number' && info.asn > 0) {
        add('asn', 'ndAsn', info.as_name ? `AS${info.asn} · ${info.as_name}` : `AS${info.asn}`);
    }
    add('connection', 'ndConnType', typeLabel(info.connection_type));
    add('iptype', 'ndIpType', typeLabel(info.user_type));
    if (info.is_anycast === true) add('anycast', 'ndAnycast', t('ndYes'));
    if (info.is_eu === true) add('eu', 'ndEu', t('ndYes'));
    return rows;
}

/** @param {ExitIpInfo | null} info */
function sourceNote(info) {
    // Nothing was looked up: no source to name.
    if (!info) return '';
    return info.source === 'cloudflare' ? t('ndSourceCloudflare') : t('ndSourceIpInfo');
}

const REFRESH_ICON = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21 12a9 9 0 1 1-3-6.7L21 8"/><path d="M21 3v5h-5"/></svg>';
const COPY_ICON = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>';
const CHECK_ICON = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M20 6 9 17l-5-5"/></svg>';

/** @type {{ el: HTMLElement, anchor: HTMLElement, leaf: string, home: HTMLElement | null, teardown: () => void } | null} */
let open = null;

/** Close the card, if open. */
export function closeNodeDetails(refocus = false) {
    if (!open) return;
    const { el, anchor, home, teardown } = open;
    open = null;
    teardown();
    el.remove();
    anchor.setAttribute('aria-expanded', 'false');
    if (!refocus) return;
    if (anchor.isConnected) {
        anchor.focus({ preventScroll: true });
        return;
    }
    // The IP line went (a refresh found nothing): the nearest control still there.
    const fallback = /** @type {HTMLElement | null} */ (home?.isConnected
        ? home.querySelector('button:not([disabled]):not([hidden]), [tabindex="0"]')
        : null);
    fallback?.focus({ preventScroll: true });
}

/**
 * Fill the card's body for `info` (null: nothing to show right now).
 * @param {HTMLElement} body
 * @param {HTMLElement} foot
 * @param {ExitIpInfo | null} info
 */
function fill(body, foot, info) {
    body.replaceChildren();
    if (!info) {
        const p = document.createElement('p');
        p.className = 'nd-empty';
        p.textContent = t('ndUnavailable');
        body.append(p);
    } else {
        const dl = document.createElement('dl');
        dl.className = 'nd-rows';
        for (const row of buildDetailRows(info)) {
            const dt = document.createElement('dt');
            dt.textContent = row.label;
            const dd = document.createElement('dd');
            dd.dataset.row = row.id;
            const v = document.createElement('span');
            v.className = 'nd-value';
            v.textContent = row.value;
            dd.append(v);
            if (row.id === 'ip') {
                const copy = document.createElement('button');
                copy.type = 'button';
                copy.className = 'nd-icon-btn';
                copy.title = t('ndCopyIp');
                copy.setAttribute('aria-label', t('ndCopyIp'));
                // eslint-disable-next-line no-unsanitized/property -- static SVG constant
                copy.innerHTML = COPY_ICON; // nosemgrep: js-innerhtml-assignment — static markup
                copy.addEventListener('click', async () => {
                    try {
                        // A newer copy took the clipboard: no tick for this one.
                        if (await copyToClipboard(info.ip) === false) return;
                        // eslint-disable-next-line no-unsanitized/property -- static SVG constant
                        copy.innerHTML = CHECK_ICON; // nosemgrep: js-innerhtml-assignment — static markup
                        setTimeout(() => {
                            // eslint-disable-next-line no-unsanitized/property -- static SVG constant
                            copy.innerHTML = COPY_ICON; // nosemgrep: js-innerhtml-assignment — static markup
                        }, 1200);
                    } catch {
                        showNotification(t('copyFailed'), 'error');
                    }
                });
                dd.append(copy);
            }
            dl.append(dt, dd);
        }
        body.append(dl);
    }
    foot.textContent = sourceNote(info);
}

/**
 * A redrawn IP line for `leaf` takes over the open card from the line it
 * replaced, so Esc returns focus to a button that is still on the page and a
 * click on it closes the card instead of opening a second one.
 * @param {HTMLElement} btn
 * @param {string} leaf
 */
export function adoptNodeDetails(btn, leaf) {
    if (!open || open.leaf !== leaf || open.anchor.isConnected) return;
    open.anchor = btn;
    btn.setAttribute('aria-expanded', 'true');
}

/**
 * Close the card when its IP button left the page with no successor (a
 * lookup again found nothing): focus goes back to the node bar.
 */
export function dropOrphanedNodeDetails() {
    if (!open || open.anchor.isConnected) return;
    const focused = document.activeElement;
    const ownsFocus = open.el.contains(focused) || !focused || focused === document.body;
    closeNodeDetails(ownsFocus);
}

/**
 * Place the card above the anchor when there is no room below.
 * @param {HTMLElement} el
 * @param {HTMLElement} anchor
 */
function place(el, anchor) {
    // <body> is scaled by --ui-scale: work in its (layout) pixels, as the
    // card's left/top are, not in the screen pixels the rectangle gives.
    const scale = Number.parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--ui-scale')) || 1;
    const rect = anchor.getBoundingClientRect();
    const r = { left: rect.left / scale, top: rect.top / scale, bottom: rect.bottom / scale };
    const vw = window.innerWidth / scale;
    const vh = window.innerHeight / scale;
    // The stylesheet's 100vw/100vh caps are screen pixels; cap in layout
    // pixels so a scaled-up card scrolls inside rather than being clipped.
    el.style.maxWidth = `${Math.floor(vw - 16)}px`;
    el.style.maxHeight = `${Math.floor(vh - 16)}px`;
    const w = el.offsetWidth || 300;
    const h = el.offsetHeight || 0;
    const left = Math.max(8, Math.min(r.left, vw - w - 8));
    const below = r.bottom + 6;
    const top = below + h > vh - 8 ? Math.max(8, r.top - 6 - h) : below;
    el.style.left = `${Math.round(left)}px`;
    el.style.top = `${Math.round(top)}px`;
}

/**
 * Open the card for `leaf`, anchored to `anchor` (the IP line). A second
 * call for the same anchor closes it.
 * @param {HTMLElement} anchor
 * @param {string} leaf
 */
export async function openNodeDetails(anchor, leaf) {
    if (open) {
        const same = open.anchor === anchor;
        closeNodeDetails();
        if (same) return;
    }
    const el = document.createElement('div');
    el.className = 'nd-pop';
    el.setAttribute('role', 'dialog');
    const titleId = 'nd-title';
    el.setAttribute('aria-labelledby', titleId);

    const head = document.createElement('div');
    head.className = 'nd-head';
    const title = document.createElement('h3');
    title.id = titleId;
    title.className = 'nd-title';
    title.textContent = t('nodeDetailsTitle');
    const refresh = document.createElement('button');
    refresh.type = 'button';
    refresh.className = 'nd-icon-btn';
    refresh.title = t('ndRefresh');
    refresh.setAttribute('aria-label', t('ndRefresh'));
    // eslint-disable-next-line no-unsanitized/property -- static SVG constant
    refresh.innerHTML = REFRESH_ICON; // nosemgrep: js-innerhtml-assignment — static markup
    head.append(title, refresh);

    /** @type {ExitIpInfo | null} */
    let shownInfo = null;
    /** @param {ExitIpInfo|null} info */
    const renderInfo = (info) => {
        const copyFocused = !!body.querySelector('button')?.contains(document.activeElement);
        shownInfo = info;
        fill(body, foot, info);
        if (copyFocused) (body.querySelector('button') || refresh).focus({ preventScroll: true });
    };
    const offLanguage = Bus.on(Events.I18N_APPLIED, () => {
        title.textContent = t('nodeDetailsTitle');
        refresh.title = t('ndRefresh');
        refresh.setAttribute('aria-label', t('ndRefresh'));
        renderInfo(shownInfo);
        if (open?.el === el && open.anchor.isConnected) place(el, open.anchor);
    });

    const body = document.createElement('div');
    body.className = 'nd-body';
    const foot = document.createElement('p');
    foot.className = 'nd-foot';
    el.append(head, body, foot);

    /** @param {MouseEvent} e */
    const onDoc = (e) => {
        const target = /** @type {Node} */ (e.target);
        // The anchor now: a redraw of the IP line hands the card to the new one.
        const at = open?.el === el ? open.anchor : anchor;
        if (!el.contains(target) && !at.contains(target)) closeNodeDetails();
    };
    /** @param {KeyboardEvent} e */
    const onKey = (e) => {
        if (e.key !== 'Escape') return;
        const at = open?.el === el ? open.anchor : anchor;
        const focus = document.activeElement;
        // Focus moved on (the card is not modal): Escape is that control's;
        // the card just goes.
        if (focus && focus !== document.body && !el.contains(focus) && !at.contains(focus)) {
            closeNodeDetails();
            return;
        }
        e.preventDefault();
        e.stopPropagation();
        closeNodeDetails(true);
    };
    const onResize = () => closeNodeDetails(el.contains(document.activeElement));
    const onBlur = () => closeNodeDetails();
    const onScroll = (/** @type {Event} */ event) => {
        if (open?.el !== el || !(event.target instanceof Node) || el.contains(event.target)) return;
        if (event.target.contains(open.anchor)) closeNodeDetails(el.contains(document.activeElement));
    };
    const teardown = () => {
        document.removeEventListener('click', onDoc, true);
        document.removeEventListener('keydown', onKey, true);
        window.removeEventListener('resize', onResize);
        window.removeEventListener('blur', onBlur);
        document.removeEventListener('scroll', onScroll, true);
        offLanguage();
    };
    // Where focus goes if the IP button is gone when the card closes.
    const home = anchor.closest('#home-node, .glass-card, [data-page]');
    open = { el, anchor, leaf, home: /** @type {HTMLElement | null} */ (home), teardown };
    anchor.setAttribute('aria-expanded', 'true');
    document.body.append(el);
    document.addEventListener('click', onDoc, true);
    document.addEventListener('keydown', onKey, true);
    window.addEventListener('resize', onResize);
    window.addEventListener('blur', onBlur);
    document.addEventListener('scroll', onScroll, true);

    /** Bumped by every lookup this card starts: only the newest one fills it. */
    let ask = 0;
    refresh.addEventListener('click', async () => {
        if (refresh.getAttribute('aria-disabled') === 'true') return;
        refresh.setAttribute('aria-disabled', 'true');
        el.setAttribute('aria-busy', 'true');
        const mine = ++ask;
        const info = await refreshExitIp(leaf);
        if (open?.el !== el || mine !== ask) return;
        refresh.removeAttribute('aria-disabled');
        el.removeAttribute('aria-busy');
        renderInfo(info);
        // The page may have redrawn the IP line meanwhile (adoptNodeDetails).
        if (open.anchor.isConnected) place(el, open.anchor);
    });

    const mine = ++ask;
    el.setAttribute('aria-busy', 'true');
    place(el, anchor);
    const info = await exitIpFor(leaf, { immediate: true });
    if (open?.el !== el || mine !== ask) return;
    el.removeAttribute('aria-busy');
    renderInfo(info);
    // The page may have redrawn the IP line while this looked up (adoptNodeDetails).
    place(el, open.anchor.isConnected ? open.anchor : anchor);
    // Only when focus is still where the card was opened from (or nowhere):
    // a user who tabbed on meanwhile keeps their place.
    const at = document.activeElement;
    if (!at || at === document.body || at === anchor || at === open.anchor || el.contains(at)) {
        refresh.focus({ preventScroll: true });
    }
}
