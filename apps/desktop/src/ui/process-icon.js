// @ts-check
/**
 * Real application icons for connection rows.
 *
 * The backend (`get_process_icon`) turns a connection's `processPath` into a
 * `data:` URL: the icon embedded in a Windows executable, the macOS `.app`
 * bundle icon, or the Linux `.desktop` / Flatpak icon. Rows without one keep a
 * neutral placeholder instead of an invented letter tile.
 */

import { invoke } from '../api.js';
import { COMMANDS } from '@zephyr/shared';

const SVG_NS = 'http://www.w3.org/2000/svg';
/** Upper bound on remembered paths; cleared wholesale when full. */
const MAX_ENTRIES = 256;
/** A path without an icon is asked about again after this long (an app may gain one). */
const MISS_TTL_MS = 5 * 60 * 1000;

/** @type {Map<string, { url: string | null, at: number }>} settled lookups (null = no icon) */
const resolved = new Map();
/** @type {Map<string, Promise<string | null>>} lookups in flight */
const pending = new Map();
/** Paths whose icon the webview could not decode: the next lookup skips the backend cache. */
const undecodable = new Set();

/** @param {unknown} url */
function isImageDataUrl(url) {
    return typeof url === 'string' && /^data:image\/(png|svg\+xml);base64,/.test(url);
}

/**
 * Icon already known for `path`: a data URL, `null` for none, `undefined` when
 * not looked up yet.
 * @param {string} path
 * @returns {string | null | undefined}
 */
export function peekProcessIcon(path) {
    const hit = resolved.get(path);
    if (!hit) return undefined;
    if (hit.url === null && Date.now() - hit.at >= MISS_TTL_MS) {
        resolved.delete(path);
        return undefined;
    }
    return hit.url;
}

/** @param {string} path @param {string | null} url */
function remember(path, url) {
    if (resolved.size >= MAX_ENTRIES && !resolved.has(path)) resolved.clear();
    resolved.set(path, { url, at: Date.now() });
}

/**
 * Look up (once per path) the icon of the executable at `path`. A failed call
 * is not remembered, so the next render asks again.
 * @param {string} path
 * @returns {Promise<string | null>}
 */
export function loadProcessIcon(path) {
    if (!path) return Promise.resolve(null);
    const known = peekProcessIcon(path);
    if (known !== undefined) return Promise.resolve(known);
    const inFlight = pending.get(path);
    if (inFlight !== undefined) return inFlight;
    const request = Promise.resolve()
        .then(() => invoke(COMMANDS.GET_PROCESS_ICON, undecodable.has(path) ? { path, fresh: true } : { path }))
        .then(
            (reply) => {
                undecodable.delete(path);
                const url = isImageDataUrl(reply) ? /** @type {string} */ (reply) : null;
                remember(path, url);
                return url;
            },
            () => null,
        )
        .finally(() => pending.delete(path));
    pending.set(path, request);
    return request;
}

/** Generic application glyph for rows without a real icon. */
function placeholderGlyph() {
    const svg = document.createElementNS(SVG_NS, 'svg');
    svg.setAttribute('viewBox', '0 0 24 24');
    svg.setAttribute('fill', 'none');
    svg.setAttribute('stroke', 'currentColor');
    svg.setAttribute('stroke-width', '1.8');
    svg.setAttribute('stroke-linecap', 'round');
    svg.setAttribute('stroke-linejoin', 'round');
    svg.setAttribute('aria-hidden', 'true');
    const frame = document.createElementNS(SVG_NS, 'rect');
    frame.setAttribute('x', '3.5');
    frame.setAttribute('y', '4.5');
    frame.setAttribute('width', '17');
    frame.setAttribute('height', '15');
    frame.setAttribute('rx', '3');
    const bar = document.createElementNS(SVG_NS, 'path');
    bar.setAttribute('d', 'M3.5 9h17');
    svg.append(frame, bar);
    return svg;
}

/**
 * An icon the webview could not decode: show the placeholder, and remember
 * that so the rows re-rendered every poll do not retry (and flicker).
 * @param {HTMLElement} slot
 * @param {string} url
 */
function onDecodeError(slot, url) {
    const path = slot.dataset.iconPath;
    if (path && resolved.get(path)?.url === url) {
        remember(path, null);
        // The backend keeps the bytes it read (a file caught mid-write, say):
        // when the miss expires, ask it to read the file again.
        // Bounded like the cache: the oldest path goes first.
        if (undecodable.size >= MAX_ENTRIES && !undecodable.has(path)) {
            undecodable.delete(/** @type {string} */ (undecodable.values().next().value));
        }
        undecodable.add(path);
    }
    paint(slot, null);
}

/**
 * Fill `slot` with the icon for `path`, or the placeholder.
 * @param {HTMLElement} slot
 * @param {string | null | undefined} url
 */
function paint(slot, url) {
    if (url) {
        const img = document.createElement('img');
        img.alt = '';
        img.decoding = 'async';
        img.draggable = false;
        img.src = url;
        img.addEventListener('error', () => onDecodeError(slot, url), { once: true });
        slot.classList.remove('is-placeholder');
        slot.replaceChildren(img);
    } else {
        slot.classList.add('is-placeholder');
        slot.replaceChildren(placeholderGlyph());
    }
}

/**
 * Icon slot for a connection row. Shows a cached icon right away; otherwise
 * the placeholder, swapped for the real icon once the lookup resolves (as long
 * as the slot still belongs to the same path).
 * @param {string} path executable path from the connection metadata ('' if unknown)
 * @param {string} [className]
 * @returns {HTMLSpanElement}
 */
export function createProcessIcon(path, className = 'dz-conn-proc') {
    const slot = document.createElement('span');
    slot.className = className;
    slot.setAttribute('aria-hidden', 'true');
    slot.dataset.iconPath = path;
    const known = path ? peekProcessIcon(path) : null;
    paint(slot, known);
    if (path && known === undefined) {
        void loadProcessIcon(path).then((url) => {
            if (!url) return;
            // The list may have re-rendered while the lookup ran: update every
            // placeholder still waiting for this path, not just this slot.
            for (const el of document.querySelectorAll('[data-icon-path].is-placeholder')) {
                if (el instanceof HTMLElement && el.dataset.iconPath === path) paint(el, url);
            }
        });
    }
    return slot;
}

/** Test hook: forget every lookup. */
export function _resetProcessIconsForTest() {
    resolved.clear();
    pending.clear();
    undecodable.clear();
}
