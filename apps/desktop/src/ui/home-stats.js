/**
 * Minimal home: live figures strip (total traffic, active connections, node latency).
 *
 * Reads only data the app already has (mihomo `/connections` and the cached
 * `/proxies` snapshot) and polls only while the minimal home is on screen and
 * the window is visible.
 */

import { getConnections, getProxiesMerged } from '../api.js';
import { getProxiesCached } from './cache.js';
import { formatBytes, getDelayColorClass } from '../utils/format.js';
import { createLogger } from '../utils/logger.js';

const logger = createLogger('HomeStats');
const POLL_MS = 2000;
/** @type {ReturnType<typeof setInterval> | null} */
let timer = null;
let inFlight = false;
const DELAY_CLASSES = ['text-emerald-400', 'text-amber-400', 'text-rose-400', 'text-[var(--zephyr-text-tertiary)]'];

/** @param {string} id @param {string} text */
function setText(id, text) {
    const el = document.getElementById(id);
    if (el && el.textContent !== text) el.textContent = text;
}

/**
 * Split "10.12 MB" into a figure and a unit so the unit can be set smaller.
 * @param {number} bytes
 * @returns {[string, string]}
 */
export function splitBytes(bytes) {
    const s = formatBytes(Math.max(0, Number(bytes) || 0));
    const i = s.lastIndexOf(' ');
    return i > 0 ? [s.slice(0, i), s.slice(i + 1)] : [s, ''];
}

/**
 * Follow a group's `now` chain down to the leaf node.
 * @param {Record<string, any>} proxies
 * @param {string} name
 * @returns {any}
 */
export function resolveLeaf(proxies, name) {
    let p = proxies?.[name];
    for (let i = 0; p && Array.isArray(p.all) && p.now && i < 8; i++) p = proxies[p.now];
    return p;
}

function homeVisible() {
    const page = document.querySelector('[data-page="home"]');
    return !!page && !page.classList.contains('hidden') && !document.hidden;
}

/** @param {number} bytes */
function renderTotal(bytes) {
    const el = document.getElementById('home-stat-total');
    if (!el) return;
    const [num, unit] = splitBytes(bytes);
    const next = `${num}\u2009${unit}`;
    if (el.textContent !== next) el.textContent = next;
}

async function tick() {
    if (inFlight || !homeVisible()) return;
    inFlight = true;
    try {
        const data = /** @type {any} */ (await getConnections());
        const down = Number(data?.downloadTotal) || 0;
        const up = Number(data?.uploadTotal) || 0;
        const conns = Array.isArray(data?.connections) ? data.connections : [];
        let udp = 0;
        for (const c of conns) if (String(c?.metadata?.network || '').toLowerCase() === 'udp') udp++;
        renderTotal(down + up);
        setText('home-stat-down', formatBytes(down));
        setText('home-stat-up', formatBytes(up));
        setText('home-stat-conn', String(conns.length));
        setText('home-stat-tcp', String(conns.length - udp));
        setText('home-stat-udp', String(udp));
    } catch (e) {
        logger.debug('connections poll failed', e);
    }
    try {
        // The pill shows a display label ("Auto - HK"); the real proxy-map key
        // of the selected group lives in data-group.
        const nodeEl = document.getElementById('current-node-name');
        const nodeName = (nodeEl?.dataset.group || nodeEl?.textContent || '').trim();
        const raw = /** @type {any} */ (await getProxiesCached());
        // Provider-downloaded nodes are missing from the raw /proxies map.
        const res = /** @type {any} */ (raw?.proxies ? await getProxiesMerged(raw) : raw);
        const proxies = res?.proxies || res || {};
        const leaf = nodeName ? resolveLeaf(proxies, nodeName) : null;
        const hist = Array.isArray(leaf?.history) ? leaf.history : [];
        const delay = hist.length ? Number(hist.at(-1)?.delay) || 0 : 0;
        const valid = delay > 0 && delay < 999999; // 999999+ means timeout
        const latEl = document.getElementById('home-stat-lat');
        if (latEl) {
            latEl.textContent = valid ? String(delay) : '—';
            latEl.classList.remove(...DELAY_CLASSES);
            if (valid) latEl.classList.add(getDelayColorClass(delay));
        }
        setText('home-stat-node', leaf?.name || nodeName || '—');
    } catch (e) {
        logger.debug('latency read failed', e);
    } finally {
        inFlight = false;
    }
}

/**
 * Start polling. Returns a cleanup function.
 * @returns {() => void}
 */
export function initHomeStats() {
    if (!document.getElementById('home-stats')) return () => {};
    const run = () => { tick().catch(e => logger.debug('home stats tick failed', e)); };
    if (!timer) timer = setInterval(run, POLL_MS);
    const onVis = () => { if (!document.hidden) run(); };
    document.addEventListener('visibilitychange', onVis);
    run();
    return () => {
        if (timer) clearInterval(timer);
        timer = null;
        document.removeEventListener('visibilitychange', onVis);
    };
}
