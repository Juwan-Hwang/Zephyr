// @ts-check
/**
 * @module ui/console-home
 *
 * Console Dashboard Home Page — a detailed, information-dense alternative
 * to the minimal home page.  Ported from console-draft.html and wired to
 * real backend data (traffic WS, connections polling, proxy state, logs).
 *
 * Layout:
 *  ┌──────────────────────────────────────────────────────────────────┐
 *  │ Header (title + uptime + view-switch)                            │
 *  ├──────────────────────────────────────────────────────────────────┤
 *  │ KPI strip (5 cards: DL / UL / total / conns / latency)           │
 *  ├───────────────────────────────┬──────────────────────────────────┤
 *  │ Real-time traffic chart       │ Node card + Quick controls       │
 *  ├──────────────┬────────────────┴──────┬───────────────────────────┤
 *  │ Connections  │ Subscription usage    │ Recent logs               │
 *  └──────────────┴───────────────────────┴───────────────────────────┘
 *
 * A "minimal" sub-view (condensed homepage) is also available via the
 * view-switch in the header — mirrors the original homepage layout.
 */

import { getConnections, testProxy, getLatencyTestSignal, resetLatencyTestController, switchProxyResult, SWITCH_BUSY, isLatestSwitch, coreReplacements, invoke, closeAllConnections, getProxiesMerged } from '../api.js';
import { noNetworkChangeSince } from './network-change.js';
import { appStore } from './state.js';

import { Bus, Events } from './events.js';
import { bind } from './bind.js';

import { subscribeToEvents, getExtLogEvents } from '../modules/backend-events.js';
import { registerCleanup } from '../utils/cleanup-registry.js';
import { createLogger } from '../utils/logger.js';
import { hexToRgb } from '../utils/color.js';
import { createCssVarCache } from '../utils/css-var-cache.js';
import { showNotification } from './notifications.js';
import { t, applyTranslations } from '../i18n.js';
import { COMMANDS } from '@zephyr/shared';
import { syncCoreConfig, resolveLeafNode, notifySwitchFailed } from './proxies.js';
import { switchToConfig } from './lifecycle.js';
import { currentProfile } from './active-profile.js';
import { readRunningProfile } from './running-profile.js';
import { fetchProxyGroups } from './proxy-groups.js';
import { saveProxySelection } from './proxy-memory.js';
import { invalidateProxiesCache, invalidateSettingsCache, invalidateConfigsCache, getSettingsCached } from './cache.js';
import { getRunConfigCached, invalidateRunConfigCache } from './run-config-cache.js';
import { getSubscriptionUserAgent } from './settings.js';
import { noteExternalClipboardWrite, nextClipboardSeq, withClipboardTimeout } from './tray.js';
import { setSysProxyEnabled, refreshSysProxyStatus } from './sysproxy.js';
import { syncNoSubscriptionState } from './no-subscription.js';
import { createProcessIcon } from './process-icon.js';
import { mirrorTunToggle } from './tun.js';
import { lowerLatencyNodes, splitFlag, exitIpButton, exitIpKey, setExitIpButtonInfo } from './home-stats.js';
import { exitIpFor, onExitIpRefreshed, retryFailedExitIp } from './exit-ip.js';
import { exitIpSummary, closeNodeDetails, adoptNodeDetails, dropOrphanedNodeDetails } from './node-details.js';
import { initHomeProfile } from './home-profile.js';
import { isSpeedTestBusy, onSpeedTestChange, withSpeedTestGroup } from './speed-test.js';
import { parseSubInfo, gb } from '../utils/sub-info.js';

/**
 * The profile a node switch is filed under, read in the switch's turn and
 * again after its answer: a failed read is no profile, and then nothing is
 * saved.
 * @returns {Promise<string>}
 */
async function profileForSwitch() {
    // Live: a cached read could still name the profile a switch replaced.
    return (await readRunningProfile()) ?? '';
}


/** Map app language code to BCP-47 locale tag for Intl APIs. */
const LOCALE_TAGS = { en: 'en', zh: 'zh-CN', ja: 'ja-JP', ko: 'ko-KR', ru: 'ru-RU', es: 'es-ES', fa: 'fa-IR', tk: 'tk-TM', my: 'my-MM', ar: 'ar-SA', ur: 'ur-PK', sw: 'sw-KE', tr: 'tr-TR', vi: 'vi-VN' };

/** Resolve the current app language to a BCP-47 locale tag. @returns {string} */
function uiLocale() {
    const lang = /** @type {keyof typeof LOCALE_TAGS} */ (appStore.get('currentLang'));
    return LOCALE_TAGS[lang] || 'en';
}

const consoleLogger = createLogger('Console', 'warn');

// ── Helpers ──────────────────────────────────────────────────────────────

/** @param {string} id */
const $ = (id) => document.getElementById(id);

/**
 * Format bytes/s → { val, unit } for display.
 * @param {number} bytesPerSec
 * @returns {{ val: string, unit: string }}
 */
function fmtSpeed(bytesPerSec) {
    if (!bytesPerSec || bytesPerSec < 1) return { val: '0', unit: 'KB/s' };
    if (bytesPerSec >= 1048576) return { val: (bytesPerSec / 1048576).toFixed(2), unit: 'MB/s' };
    return { val: Math.round(bytesPerSec / 1024).toString(), unit: 'KB/s' };
}

/**
 * Format bytes → human-readable string.
 * @param {number} bytes
 * @returns {string}
 */
function fmtBytes(bytes) {
    if (!bytes || bytes < 1) return '0 B';
    if (bytes >= 1073741824) return (bytes / 1073741824).toFixed(2) + ' GB';
    if (bytes >= 1048576) return (bytes / 1048576).toFixed(1) + ' MB';
    if (bytes >= 1024) return Math.round(bytes / 1024) + ' KB';
    return bytes + ' B';
}

/**
 * Theme variables read by the chart. Resolving them through getComputedStyle
 * on every repaint forced a style recalc per traffic tick; the cache is
 * dropped on theme events and whenever <html>'s class/style changes.
 */
const _cssVars = createCssVarCache();

/** @param {string} name */
function cssVar(name) {
    return _cssVars.get(name);
}

/**
 * Resolve the fixed traffic colours (download = blue, upload = coral) as
 * "r,g,b" strings for canvas drawing. They follow light/dark mode via the
 * design tokens but never the theme accent.
 * @returns {{ down: string, up: string }}
 */
function trafficRgb() {
    /** @param {string} name @param {string} fallback */
    const toRgb = (name, fallback) => {
        const c = hexToRgb(cssVar(name)) || hexToRgb(fallback);
        return c ? `${c.r},${c.g},${c.b}` : '0,0,0';
    };
    return {
        down: toRgb('--zephyr-color-download', '#0A84FF'),
        up: toRgb('--zephyr-color-upload', '#FF6B6B'),
    };
}

/** @param {number} v */
function latBadge(v) {
    return v > 0 && v < 80 ? ['latency-badge--fast', t('consoleLatencyExcellent')]
        : v > 0 && v < 160 ? ['latency-badge--medium', t('consoleLatencyFair')]
        : ['latency-badge--slow', t('consoleLatencyHigh')];
}

// ── State ────────────────────────────────────────────────────────────────

/** @type {Array<{ up: number, down: number, time: number }>} */
let trafficHistory = [];
/** @type {{ down: number, up: number, downPeak: number, upPeak: number, sessDown: number, sessUp: number, totalDown: number, totalUp: number, conns: number, latency: number }} */
const state = { down: 0, up: 0, downPeak: 0, upPeak: 0, sessDown: 0, sessUp: 0, totalDown: 0, totalUp: 0, conns: 0, latency: 0 };

/** @type {ReturnType<typeof setInterval> | null} */
let connPollTimer = null;
/** @type {ReturnType<typeof setTimeout> | null} */
let nodeRetryTimer = null;
let isInitialized = false;
let isActive = false;
/** @type {number | null} Timestamp (ms) of the last traffic sample for lifetime totals (never reset). */
let lastTrafficTsMsTotal = null;
/** @type {number | null} Timestamp (ms) of the last traffic sample for session totals (reset on activate). */
let lastTrafficTsMsSession = null;
/** @type {number} Pending requestAnimationFrame id for traffic chart repaint (0 = none). */
let trafficRaf = 0;

/** @type {Function[]} */
const _cleanups = [];
/** @type {Function[]} Unregister functions for global registry entries. */
const _globalUnregs = [];

/**
 * Register an event listener and push a matching removal function into _cleanups.
 * Ensures every listener is tracked for consistent teardown on retry/destroy.
 * @param {EventTarget} el
 * @param {string} event
 * @param {Function} handler
 * @param {boolean | AddEventListenerOptions} [options]
 */
function on(el, event, handler, options) {
    const listener = /** @type {EventListener} */ (handler);
    el.addEventListener(event, listener, options);
    _cleanups.push(() => el.removeEventListener(event, listener, options));
}

// ── Canvas Chart (ported from draft) ─────────────────────────────────────

/**
 * @param {HTMLCanvasElement} canvas
 * @returns {{ ctx: CanvasRenderingContext2D, w: number, h: number }}
 */
function setupCanvas(canvas) {
    const dpr = window.devicePixelRatio || 1;
    const rect = canvas.getBoundingClientRect();
    const targetW = Math.max(1, Math.round(rect.width * dpr));
    const targetH = Math.max(1, Math.round(rect.height * dpr));
    const ctx = canvas.getContext('2d');
    if (!ctx) return { ctx: /** @type {any} */ (null), w: 0, h: 0 };
    // Assigning canvas.width/height reallocates the backing store and
    // invalidates layout even when the value is unchanged, so only resize
    // when the size really changed; otherwise just clear the bitmap
    // (resizing would have cleared it implicitly).
    // Each assignment reallocates, so touch only the dimension that changed.
    const resized = canvas.width !== targetW || canvas.height !== targetH;
    if (canvas.width !== targetW) canvas.width = targetW;
    if (canvas.height !== targetH) canvas.height = targetH;
    if (!resized) {
        ctx.setTransform(1, 0, 0, 1, 0, 0);
        ctx.clearRect(0, 0, canvas.width, canvas.height);
    }
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    return { ctx, w: rect.width, h: rect.height };
}

/**
 * @param {CanvasRenderingContext2D} ctx
 * @param {number} w
 * @param {number} h
 * @param {Array<{ up: number, down: number }>} data
 * @param {'up' | 'down'} key
 * @param {number} max
 * @param {string} rgb
 * @param {number} fillAlpha - top-of-gradient fill opacity (0 = no fill)
 * @param {number} lineWidth
 */
function drawSeries(ctx, w, h, data, key, max, rgb, fillAlpha, lineWidth) {
    const n = data.length;
    if (n < 2) return;
    const step = w / (n - 1);

    // Shared path builder: constructs the quadratic-curve segment list.
    // `firstCmd` is 'lineTo' for the fill path (starts from bottom-left)
    // or 'moveTo' for the stroke path (starts at the first data point).
    /** @param {'moveTo' | 'lineTo'} firstCmd */
    const buildPath = (firstCmd) => {
        ctx.beginPath();
        for (let i = 0; i < n; i++) {
            const x = i * step;
            const y = h - (data[i][key] / max) * (h - 8);
            if (i === 0) ctx[firstCmd](x, y);
            else {
                const px = (i - 1) * step;
                const py = h - (data[i - 1][key] / max) * (h - 8);
                ctx.quadraticCurveTo((px + x) / 2, py, x, (py + y) / 2);
            }
        }
    };

    // Fill path: data curve → bottom-right → bottom-left → close.
    // The first data point sits at x=0, so closePath draws a vertical
    // line from (0, h) back to it — correctly anchoring the fill area.
    if (fillAlpha > 0) {
        buildPath('lineTo');
        ctx.lineTo(w, h);
        ctx.lineTo(0, h);
        ctx.closePath();
        const g = ctx.createLinearGradient(0, 0, 0, h);
        g.addColorStop(0, `rgba(${rgb},${fillAlpha})`);
        g.addColorStop(1, `rgba(${rgb},0)`);
        ctx.fillStyle = g;
        ctx.fill();
    }

    // Stroke path: data curve only.
    buildPath('moveTo');
    ctx.strokeStyle = `rgba(${rgb},0.9)`;
    ctx.lineWidth = lineWidth;
    ctx.stroke();
}

/** @param {HTMLElement | null} canvas */
function drawChart(canvas) {
    if (!canvas || !canvas.isConnected) return;
    const { ctx, w, h } = setupCanvas(/** @type {HTMLCanvasElement} */ (canvas));
    if (!ctx || w < 10 || h < 10) return;
    const max = Math.max(1024, ...trafficHistory.flatMap((p) => [p.down, p.up])) * 1.15;
    ctx.strokeStyle = cssVar('--zephyr-border-subtle') || 'rgba(128,128,128,.1)';
    ctx.lineWidth = 1;
    for (let i = 1; i <= 3; i++) {
        const y = (h / 4) * i;
        ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(w, y); ctx.stroke();
    }
    // Fixed palette — does NOT follow theme accent (speed colors must be stable):
    // download = blue with gradient fill, upload = coral with a faint fill.
    const rgb = trafficRgb();
    drawSeries(ctx, w, h, trafficHistory, 'down', max, rgb.down, 0.22, 1.8);
    drawSeries(ctx, w, h, trafficHistory, 'up', max, rgb.up, 0.06, 1.4);
}

/** @param {HTMLElement | null} canvas @param {'up' | 'down'} key @param {string} rgb */
function drawSpark(canvas, key, rgb) {
    if (!canvas) return;
    const { ctx, w, h } = setupCanvas(/** @type {HTMLCanvasElement} */ (canvas));
    if (!ctx || w < 4 || h < 4) return;
    const data = trafficHistory.slice(-24);
    if (data.length < 2) return;
    const max = Math.max(...data.map((p) => p[key])) * 1.1 || 1;
    ctx.beginPath();
    data.forEach((p, i) => {
        const x = (i / (data.length - 1)) * w;
        const y = h - (p[key] / max) * (h - 3);
        i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
    });
    ctx.strokeStyle = `rgba(${rgb},0.85)`;
    ctx.lineWidth = 1.4;
    ctx.stroke();
}

// ── Number rendering ─────────────────────────────────────────────────────

/**
 * Format a speed value into a display string (value + unit).
 * @param {number} bps - bytes per second
 * @returns {string}
 */
function fmtSpeedStr(bps) {
    const s = fmtSpeed(bps);
    return `${s.val} ${s.unit}`;
}

/** @param {string} id @param {string} value */
function setText(id, value) {
    const el = $(id);
    if (el) el.textContent = value;
}

function renderSpeeds() {
    const d = fmtSpeed(state.down), u = fmtSpeed(state.up);
    setText('dz-down-val', d.val);
    setText('dz-down-unit', d.unit);
    setText('dz-up-val', u.val);
    setText('dz-up-unit', u.unit);
}

function renderPeaks() {
    // Always write peak values so a reset (CORE_RESTARTED) clears old display
    setText('dz-down-peak', state.downPeak > 0 ? fmtSpeedStr(state.downPeak) : '-');
    setText('dz-up-peak', state.upPeak > 0 ? fmtSpeedStr(state.upPeak) : '-');
    const avg = trafficHistory.length > 0
        ? trafficHistory.reduce((s, p) => s + p.down, 0) / trafficHistory.length
        : 0;
    setText('dz-avg-down', fmtSpeedStr(avg) + ' ↓');
}

function renderTotals() {
    // KPI: Lifetime traffic (accumulated since core start)
    setText('dz-total-val', fmtBytes(state.totalDown + state.totalUp));
    setText('dz-total-down', fmtBytes(state.totalDown));
    setText('dz-total-up', fmtBytes(state.totalUp));
}

function renderSessionTotals() {
    // Chart meta: Session traffic
    setText('dz-sess-down', fmtBytes(state.sessDown));
    setText('dz-sess-up', fmtBytes(state.sessUp));
}

function renderNumbers() {
    renderSpeeds();
    renderPeaks();
    renderTotals();
    renderSessionTotals();
}


/**
 * How the latency read-out is shown:
 * - `value`: a measured delay in ms
 * - `pending`: a first measurement is on its way (small spinner, no placeholder dash)
 * - `timeout`: the last test failed
 * - `none`: there is no node to measure
 * @typedef {'value' | 'pending' | 'timeout' | 'none'} LatencyStatus
 */

/** @type {LatencyStatus} */
let latencyStatus = 'pending';

/**
 * Text of a latency value element for `status`.
 * @param {number} v
 * @param {LatencyStatus} status
 */
function latencyText(v, status) {
    if (status === 'value') return String(v);
    if (status === 'timeout') return t('timeout');
    if (status === 'none') return '—';
    return '';
}

/**
 * @param {number} v delay in ms; <= 0 means the test failed
 * @param {LatencyStatus} [status]
 */
function renderLatency(v, status = v > 0 ? 'value' : 'timeout') {
    const stopped = document.getElementById('app-main-container')?.classList.contains('core-down');
    if (stopped) status = 'none';
    state.latency = status === 'value' ? v : 0;
    latencyStatus = status;
    const text = stopped ? t('homeStopped') : latencyText(v, status);
    for (const id of ['dz-lat-val', 'dz-node-lat']) {
        const el = $(id);
        if (!el) continue;
        if (status === 'pending') {
            // The spinner is CSS-only: give screen readers the words for it.
            const label = document.createElement('span');
            label.className = 'dz-sr-only';
            label.textContent = t('loading');
            el.replaceChildren(label);
            el.setAttribute('aria-busy', 'true');
        } else {
            el.textContent = text;
            el.removeAttribute('aria-busy');
        }
        el.classList.toggle('is-pending', status === 'pending');
        el.classList.toggle('is-text', status === 'timeout');
        el.parentElement?.setAttribute('data-lat-state', status);
    }
    renderLatencyBadges(v, status);
    const leaf = $('dz-node-name')?.dataset.leaf;
    if (_lastNodeArgs && leaf && (resolveLeafNode(_lastNodeArgs[0], _lastNodeArgs[1]) || _lastNodeArgs[0]) === leaf) {
        renderNodeAlts(_lastNodeArgs[1], leaf);
    }
}

/**
 * @param {number} v
 * @param {LatencyStatus} status
 */
function renderLatencyBadges(v, status) {
    const [cls, txt] = status === 'value' ? latBadge(v) : ['', ''];
    for (const id of ['dz-lat-badge', 'dz-node-lat-badge']) {
        const b = $(id);
        if (!b) continue;
        b.className = cls ? 'latency-badge ' + cls : 'latency-badge';
        b.textContent = txt;
        b.hidden = status !== 'value';
    }
}

/** A delay the core reports for a working node (999999+ / 0 mean failure). @param {unknown} d */
const isUsableDelay = (d) => typeof d === 'number' && d > 0 && d < 999999;

/**
 * Last delay seen per leaf node, so returning to the console paints at once.
 * `delay <= 0` records a failed test.
 * @type {Map<string, { delay: number, at: number }>}
 */
const latencyByNode = new Map();
/** A failed automatic test is not repeated for this long. */
const LATENCY_RETRY_MS = 30_000;
/** @type {Set<string>} leaves with an automatic test in flight */
const latencyProbes = new Set();
/** @type {Set<string>} leaves the Test button is measuring */
const manualLatencyTests = new Set();
/** Bumped when remembered delays are dropped, so a test that started before is not kept. */
let latencyGeneration = 0;

/** @param {string} leaf @param {number} delay @param {number} [at] when it was measured */
function rememberLatency(leaf, delay, at = Date.now()) {
    if (leaf) latencyByNode.set(leaf, { delay, at });
}

/** @type {Map<string, number>} per node, the newest test started */
const latencyRequests = new Map();
/** Numbers tests across all nodes, so clearing the map never reuses a number. */
let latencyRequestSeq = 0;

/**
 * Number a new test of `leaf`. Only the newest test's result is kept: an
 * automatic test still running when the Test button starts another must not
 * replace that newer result when it finishes later.
 * @param {string} leaf
 */
function startLatencyRequest(leaf) {
    const id = ++latencyRequestSeq;
    latencyRequests.set(leaf, id);
    return id;
}

/** @param {string} leaf @param {number} id */
const isLatestLatencyRequest = (leaf, id) => latencyRequests.get(leaf) === id;

/**
 * Forget every remembered delay: after a core restart or config change a node
 * name may point at a different server, and the core's own history is gone.
 */
function forgetLatencies() {
    latencyByNode.clear();
    // Tests still running belong to the old config: their results are dropped
    // either way, and the map does not grow across configs.
    latencyRequests.clear();
    latencyGeneration++;
    const alternatives = $('dz-node-alts-list');
    if (alternatives?.contains(document.activeElement)) $('dz-node-picker-btn')?.focus({ preventScroll: true });
    alternatives?.replaceChildren();
    const wrap = $('dz-node-alts');
    if (wrap) wrap.hidden = true;
}

/**
 * Test `leaf` once. `cancelled` means a global stop (node switch, config
 * switch, core restart) aborted it, which says nothing about the node.
 * @param {string} leaf
 * @returns {Promise<{ delay: number, cancelled: boolean }>}
 */
export async function measureLatency(leaf) {
    // A stop or switch earlier leaves the shared signal aborted, and a later one
    // could not be told apart from a timeout: with no full test running, start
    // from a fresh controller (as the proxies page does).
    // A download test is running: a probe now would share its bandwidth (and
    // read slow); it says nothing about the node.
    if (isSpeedTestBusy()) return { delay: -1, cancelled: true };
    if (getLatencyTestSignal().aborted && !appStore.get('isTestingLatency')) resetLatencyTestController();
    const signal = getLatencyTestSignal();
    // A stopped full test is still winding down: this test would be cut short.
    if (signal.aborted) return { delay: -1, cancelled: true };
    /** @type {unknown} */
    let result = -1;
    try {
        result = await testProxy(leaf, 5000);
    } catch {
        result = -1;
    }
    if (getLatencyTestSignal() !== signal) return { delay: -1, cancelled: true };
    if (isUsableDelay(result)) return { delay: /** @type {number} */ (result), cancelled: false };
    return { delay: -1, cancelled: signal.aborted || getLatencyTestSignal() !== signal };
}

/**
 * The delay to show from the core's history: its last entry, unless a test
 * from here (the Test button, a probe) is newer — that one is kept until the
 * history catches up. `null` without history.
 * @param {any[]} history  the node's /proxies history ({ time, delay })
 * @param {{ delay: number, at: number } | undefined} seen
 * @returns {{ delay: number, at: number } | null}
 */
export function latencyFromHistory(history, seen) {
    if (history.length === 0) return null;
    const last = history[history.length - 1];
    const testedAt = Date.parse(last?.time);
    if (seen && Number.isFinite(testedAt) && seen.at > testedAt) return seen;
    const delay = Number(last?.delay) || 0;
    return { delay: isUsableDelay(delay) ? delay : -1, at: Number.isFinite(testedAt) ? testedAt : Date.now() };
}

/**
 * The latency to show for a node: the core's history, or the last result from
 * here when newer. `null` means measure it now: never tested since the core
 * started, or the latest result is a failure old enough to try again (also
 * when older history exists).
 * @param {any[]} history  the node's /proxies history ({ time, delay })
 * @param {{ delay: number, at: number } | undefined} seen
 * @param {number} [now]
 * @returns {{ delay: number, at: number } | null}
 */
export function latencyToShow(history, seen, now = Date.now()) {
    const shown = latencyFromHistory(history, seen) ?? seen ?? null;
    // A failure is retried once it is old enough, whether this page measured
    // it or it came from the core's history (which is rebuilt on every read).
    if (shown && shown.delay <= 0 && now - shown.at >= LATENCY_RETRY_MS) return null;
    return shown;
}

/**
 * Show the current node's latency without a placeholder dash: the core's
 * history when it has one, else the last value we saw, else test it now.
 * @param {string} leaf
 * @param {any} node proxy entry from /proxies
 */
function showNodeLatency(leaf, node) {
    if (!leaf) {
        renderLatency(0, 'none');
        return;
    }
    const history = Array.isArray(node?.history) ? node.history : [];
    const seen = latencyByNode.get(leaf);
    const shown = latencyToShow(history, seen);
    if (shown) {
        if (shown !== seen) rememberLatency(leaf, shown.delay, shown.at);
        renderLatency(shown.delay);
        // A recent failure (from the history or a Test click) is retried once
        // it is old enough, the same as a failed probe.
        if (shown.delay <= 0) retryFailedLatency(leaf);
        return;
    }
    // Never tested since the core started (common for manually picked nodes),
    // or our last test failed a while ago: measure it now.
    renderLatency(0, 'pending');
    void probeLatency(leaf);
}

const LATENCY_RETRY_DELAY_MS = 250;

/** @param {string} leaf */
async function probeLatency(leaf) {
    // The Test button is measuring this node: its result is shown.
    if (latencyProbes.has(leaf) || manualLatencyTests.has(leaf)) return;
    latencyProbes.add(leaf);
    const generation = latencyGeneration;
    const request = startLatencyRequest(leaf);
    /** @type {{ delay: number, cancelled: boolean }} */
    let outcome;
    try {
        outcome = await measureLatency(leaf);
    } finally {
        latencyProbes.delete(leaf);
    }
    // A newer test of this node (the Test button) has the say. If that one is
    // done and the card still waits (it found its result stale and its own
    // re-probe was turned away by this one), measure again.
    if (!isLatestLatencyRequest(leaf, request)) {
        if (isActive && latencyStatus === 'pending' && !manualLatencyTests.has(leaf)
            && $('dz-node-name')?.dataset.leaf === leaf) retryLatencyLater(leaf);
        return;
    }
    const stale = generation !== latencyGeneration;
    if (!outcome.cancelled && !stale) rememberLatency(leaf, outcome.delay);
    // The user may have switched node (or left the page) meanwhile.
    if (!isActive || $('dz-node-name')?.dataset.leaf !== leaf) return;
    if (outcome.cancelled || stale) {
        // Not a result for this node (stopped by a switch, or from before a
        // restart): measure again rather than show a timeout or spin forever.
        if (latencyStatus === 'pending') retryLatencyLater(leaf);
        return;
    }
    renderLatency(outcome.delay);
    if (outcome.delay <= 0) retryFailedLatency(leaf);
}

/** @type {ReturnType<typeof setTimeout> | null} */
let failedLatencyTimer = null;

/**
 * How long until a failure measured at `at` may be tested again (a little
 * past the threshold, so `latencyToShow` agrees).
 * @param {number|undefined} at
 * @param {number} [now]
 */
export function failedRetryDelay(at, now = Date.now()) {
    const age = Number.isFinite(at) ? now - /** @type {number} */ (at) : 0;
    return Math.max(0, LATENCY_RETRY_MS - Math.max(0, age)) + 100;
}

/**
 * A failed test is shown until it may be repeated; nothing else re-reads the
 * node while the console stays open, so test it again then if it is still
 * the node shown and still the same failure.
 * @param {string} leaf
 */
function retryFailedLatency(leaf) {
    if (failedLatencyTimer) clearTimeout(failedLatencyTimer);
    const failed = latencyByNode.get(leaf);
    failedLatencyTimer = setTimeout(() => {
        failedLatencyTimer = null;
        if (!isActive || $('dz-node-name')?.dataset.leaf !== leaf) return;
        if (latencyByNode.get(leaf) !== failed) return;
        showNodeLatency(leaf, undefined);
    }, failedRetryDelay(failed?.at));
}

/** @type {(() => void) | null} */
let pendingLatencyRetry = null;

/**
 * Run `run` later, never in the same tick: a stopped full test returns
 * "cancelled" at once until it finishes, so an immediate retry would spin in
 * microtasks and keep that test from ever clearing `isTestingLatency`. While
 * such a test winds down this waits for it; otherwise for a short timer.
 * @param {() => void} run
 * @returns {() => void} cancels the retry
 */
export function scheduleLatencyRetry(run) {
    if (isSpeedTestBusy()) {
        let cancelled = false;
        const unsubscribe = onSpeedTestChange(() => {
            if (isSpeedTestBusy()) return;
            unsubscribe();
            // Stop clears the UI before the native download has released the route.
            void withSpeedTestGroup(async () => {}).then(() => { if (!cancelled) run(); });
        });
        return () => { cancelled = true; unsubscribe(); };
    }
    if (appStore.get('isTestingLatency') && getLatencyTestSignal().aborted) {
        const unsubscribe = appStore.subscribe('isTestingLatency', (/** @type {unknown} */ testing) => {
            if (testing) return;
            unsubscribe();
            run();
        });
        return () => { unsubscribe(); };
    }
    const timer = setTimeout(run, LATENCY_RETRY_DELAY_MS);
    return () => clearTimeout(timer);
}

/** @param {string} leaf */
function retryLatencyLater(leaf) {
    pendingLatencyRetry?.();
    pendingLatencyRetry = scheduleLatencyRetry(() => {
        pendingLatencyRetry = null;
        if (isActive && latencyStatus === 'pending' && $('dz-node-name')?.dataset.leaf === leaf) void probeLatency(leaf);
    });
}

// ── Connections ──────────────────────────────────────────────────────────

/**
 * @typedef {{ proc: string, procPath: string, host: string, chain: string, tcp: boolean, speed: number, total: number }} ConnRow
 */

/** Connection sort modes
 * @type {Array<{ key: string, labelKey: string, cmp: (a: ConnRow, b: ConnRow) => number }>}
 */
const SORT_MODES = [
    { key: 'speed', labelKey: 'consoleSortBySpeed', cmp: (a, b) => b.speed - a.speed },
    { key: 'total', labelKey: 'consoleSortByTraffic', cmp: (a, b) => b.total - a.total },
    { key: 'proc',  labelKey: 'consoleSortByProcess', cmp: (a, b) => a.proc.localeCompare(b.proc) },
];
let sortIdx = 0;

/**
 * Previous snapshot of per-connection upload/download for speed calculation.
 * Keyed by connection ID → { up, down, ts }.
 * @type {Map<string, { up: number, down: number, ts: number }>}
 */
let prevConnStats = new Map();

/** @param {Array<any>} rawConns */
function processConnections(rawConns) {
    const now = Date.now();
    const rows = rawConns.map((c) => {
        const md = c.metadata || {};
        const procPath = typeof md.processPath === 'string' ? md.processPath : '';
        const proc = md.process || procPath.split(/[\\/]/).pop() || t('unknown');
        const host = md.host ? md.host + ':' + (md.destinationPort || '') : (md.destinationIP || t('unknown'));
        const chain = (c.chains && c.chains.length > 0) ? c.chains.join(' → ') : 'DIRECT';
        const upload = c.upload || 0;
        const download = c.download || 0;
        const id = /** @type {string} */ (c.id || '');

        // Compute actual speed (bytes/sec) from delta against previous snapshot
        let speed = 0;
        const prev = prevConnStats.get(id);
        if (prev) {
            const dt = (now - prev.ts) / 1000;
            if (dt > 0) {
                const dUp = Math.max(0, upload - prev.up);
                const dDown = Math.max(0, download - prev.down);
                speed = (dUp + dDown) / dt;
            }
        }

        return {
            proc: proc,
            procPath,
            host: host,
            chain: chain,
            tcp: (md.network || 'tcp').toLowerCase() === 'tcp',
            speed: speed,
            total: (upload + download) / 1024 / 1024, // MB
        };
    });

    // Save snapshot for next poll
    const next = new Map();
    for (const c of rawConns) {
        const id = /** @type {string} */ (c.id || '');
        if (id) next.set(id, { up: c.upload || 0, down: c.download || 0, ts: now });
    }
    prevConnStats = next;

    const total = rawConns.length;
    const tcpTotal = rawConns.filter((c) => ((c.metadata?.network || 'tcp').toLowerCase() === 'tcp')).length;
    return { rows, total, tcpTotal };
}

function renderConns(/** @type {ReturnType<typeof processConnections>} */ data) {
    const conns = data.rows;
    conns.sort(SORT_MODES[sortIdx].cmp);
    const el = $('dz-conn-list');
    if (!el) return;
    el.replaceChildren();
    const top = conns.slice(0, 5);
    for (const c of top) {
        const s = fmtSpeed(c.speed);
        const row = document.createElement('div');
        row.className = 'dz-conn-row';
        const procEl = createProcessIcon(c.procPath);
        const info = document.createElement('div');
        info.className = 'dz-conn-info';
        const hostEl = document.createElement('div');
        hostEl.className = 'dz-conn-host';
        hostEl.textContent = c.host;
        const chainEl = document.createElement('div');
        chainEl.className = 'dz-conn-chain';
        chainEl.textContent = `${c.proc} · ${c.tcp ? 'TCP' : 'UDP'} · `;
        const chainSpan = document.createElement('span');
        chainSpan.className = c.chain === 'DIRECT' ? 'dz-chain-direct' : 'dz-chain-proxy';
        chainSpan.textContent = c.chain;
        chainEl.appendChild(chainSpan);
        info.append(hostEl, chainEl);
        const speedEl = document.createElement('div');
        speedEl.className = 'dz-conn-speed';
        speedEl.textContent = `${s.val} ${s.unit}`;
        const totalSmall = document.createElement('small');
        totalSmall.textContent = c.total.toFixed(1) + ' MB';
        speedEl.appendChild(totalSmall);
        row.append(procEl, info, speedEl);
        el.appendChild(row);
    }
    state.conns = data.total;
    const connVal = $('dz-conn-val');
    if (connVal) connVal.textContent = String(data.total);
    const tcpEl = $('dz-conn-tcp');
    if (tcpEl) tcpEl.textContent = String(data.tcpTotal);
    const udpEl = $('dz-conn-udp');
    if (udpEl) udpEl.textContent = String(data.total - data.tcpTotal);

}

/** @type {boolean} In-flight guard for pollConnections. */
let _pollInFlight = false;
/** Set once /connections has reported the core's lifetime byte counters. */
let hasCoreTotals = false;
/** Bumped on CORE_RESTARTED so a reply from the previous core is not shown as the new one's totals. */
let coreGeneration = 0;

/** @param {unknown} value @returns {number} NaN when the core did not report it */
const coreCounter = (value) => (value == null ? Number.NaN : Number(value));

async function pollConnections() {
    if (!isActive || _pollInFlight) return;
    _pollInFlight = true;
    const generation = coreGeneration;
    try {
        const data = await getConnections();
        if (generation !== coreGeneration) return;
        // Total traffic comes from the core's own counters (the same source as the
        // minimal home), not from integrating the speed while this page is open.
        const coreDown = coreCounter(/** @type {any} */ (data)?.downloadTotal);
        const coreUp = coreCounter(/** @type {any} */ (data)?.uploadTotal);
        // Tracks the latest response, so a core without counters falls back to the speed.
        hasCoreTotals = Number.isFinite(coreDown) && Number.isFinite(coreUp);
        if (hasCoreTotals) {
            state.totalDown = coreDown;
            state.totalUp = coreUp;
            renderTotals();
        }
        const conns = processConnections(data.connections || []);
        renderConns(conns);
    } catch (e) {
        consoleLogger.warn('Failed to poll connections', e);
    } finally {
        _pollInFlight = false;
    }
}

// ── Node card ────────────────────────────────────────────────────────────

/** @type {Array<{ name: string, type: string, host: string, lat: number }>} */
let pickerNodes = [];
let pickerGroupName = '';
let pickerGeneration = -1;
let nodeSelectionRevision = 0;
let activeNodeIdx = 0;
/** @type {Array<{ name: string, file: string, active: boolean }>} */
let subConfigs = [];

/**
 * Retry delays for refreshNodeData (ms). Handles transient failures:
 * mihomo not ready, proxy-providers still downloading, network timing.
 * Stops retrying once data is successfully rendered.
 */
const NODE_RETRY_DELAYS = [800, 2000, 4000];
let nodeRetryCount = 0;
/** @type {boolean} In-flight guard to prevent concurrent refreshNodeData executions. */
let _refreshInFlight = false;
/** @type {boolean} Whether a refresh was requested during an in-flight call. */
let _refreshQueued = false;
/** @type {boolean} Whether the queued request needs forceInvalidate. */
let _refreshQueuedForce = false;

/**
 * Fetch subscription configs for picker tabs.
 * @returns {Promise<Array<{ name: string, file: string, active: boolean }>>}
 */
async function loadSubConfigs() {
    try {
        const settings = await getSettingsCached();
        const currentConfig = currentProfile(settings);
        const allConfigs = await invoke(COMMANDS.LIST_CONFIGS);
        return (allConfigs || [])
            .filter((/** @type {any} */ c) => c.url_display)
            .map((/** @type {any} */ c) => ({
                name: (c.name || '').replace(/\.(yaml|yml)$/i, ''),
                file: c.name,
                active: c.name === currentConfig,
            }));
    } catch (subErr) {
        consoleLogger.warn('Failed to fetch subscription configs', subErr);
        return [];
    }
}

/**
 * Build a server/port lookup from run_config.yaml's `proxies:` array.
 * @param {any} runConfig
 * @returns {Record<string, {server?: string, port?: number|string}>}
 */
function buildHostMap(runConfig) {
    /** @type {Record<string, {server?: string, port?: number|string}>} */
    const hostMap = {};
    if (Array.isArray(runConfig?.proxies)) {
        for (const p of runConfig.proxies) {
            if (p?.name) hostMap[p.name] = { server: p.server, port: p.port };
        }
    }
    return hostMap;
}

/**
 * Build picker nodes, host map, and current node name from proxy groups result.
 * @param {any} proxyGroupsResult
 * @param {number} generation  latencyGeneration when the data was requested
 * @param {string|null} preferredGroupName selected before the fetch
 * @param {number} selectionRevision selected-node revision before the fetch
 * @returns {Promise<{ currentNodeName: string, proxyMap: Record<string, any>, hostMap: Record<string, {server?: string, port?: number|string}> } | null>}
 */
async function buildPickerFromProxyGroups(proxyGroupsResult, generation, preferredGroupName, selectionRevision) {
    let proxyMap = /** @type {Record<string, any>} */ (/** @type {any} */ (proxyGroupsResult.data)?.proxies || {});
    let currentNodeName = proxyGroupsResult.current || '';
    const uiGroupName = proxyGroupsResult.uiGroupName || proxyGroupsResult.mainGroup || '';
    if (uiGroupName && proxyMap[uiGroupName]) {
        currentNodeName = proxyMap[uiGroupName].now || currentNodeName;
    }
    // Persist the resolved group so the picker click handler can use it
    // even when the user has not visited the Proxies page yet.
    // Not from data fetched before a restart or config change: a queued
    // refresh would then prefer that old group.
    if (selectionRevision !== nodeSelectionRevision || (appStore.get('uiGroupName') || null) !== preferredGroupName) return null;
    if (uiGroupName && generation === latencyGeneration) appStore.set('uiGroupName', uiGroupName);
    const resolvedGroup = appStore.get('uiGroupName') || null;

    // Paint the latency now; the subscription and host lookups below are slower.
    // Only while the card still names this node (or none yet), so a switch
    // never shows the new node's delay beside the old node's name.
    // Not when a restart or config change came in meanwhile: this history is
    // the old servers' (the caller drops the data and reads again).
    let earlyLeaf = resolveLeafNode(currentNodeName, proxyMap) || currentNodeName;
    const firstShownLeaf = $('dz-node-name')?.dataset.leaf;
    if (generation === latencyGeneration && earlyLeaf && proxyMap[earlyLeaf] && firstShownLeaf !== earlyLeaf) {
        if (firstShownLeaf && firstShownLeaf !== earlyLeaf) forgetNodeIp();
        const alternatives = $('dz-node-alts-list');
        if (alternatives?.contains(document.activeElement)) $('dz-node-picker-btn')?.focus({ preventScroll: true });
        alternatives?.replaceChildren();
        const alts = $('dz-node-alts');
        if (alts) alts.hidden = true;
        paintNodeIdentity(currentNodeName, earlyLeaf, proxyMap[earlyLeaf], undefined);
    }
    if (generation === latencyGeneration && earlyLeaf && proxyMap[earlyLeaf]) {
        showNodeLatency(earlyLeaf, proxyMap[earlyLeaf]);
    }
    // A provider's nodes are not in raw /proxies: without their entry the card
    // has no history (a later failed full test would never show) and no type.
    if (earlyLeaf) {
        const merged = await getProxiesMerged(proxyGroupsResult.data).catch(() => null);
        if (selectionRevision !== nodeSelectionRevision || (appStore.get('uiGroupName') || null) !== resolvedGroup) return null;
        if (merged?.proxies) {
            proxyMap = merged.proxies;
            earlyLeaf = resolveLeafNode(currentNodeName, proxyMap) || currentNodeName;
        }
    }
    const shownLeaf = $('dz-node-name')?.dataset.leaf;
    if (generation === latencyGeneration && earlyLeaf && (!shownLeaf || shownLeaf === earlyLeaf)) {
        showNodeLatency(earlyLeaf, proxyMap[earlyLeaf] || proxyMap[currentNodeName]);
    }

    // Fetch subscription configs for picker tabs
    const nextSubConfigs = await loadSubConfigs();

    // Build host map from run_config.yaml
    const runConfig = await getRunConfigCached();
    const hostMap = buildHostMap(runConfig);
    if (selectionRevision !== nodeSelectionRevision || generation !== latencyGeneration || (appStore.get('uiGroupName') || null) !== resolvedGroup) return null;

    // Build the flat node list for the picker
    subConfigs = nextSubConfigs;
    const activeGroupAll = proxyMap[uiGroupName]?.all || [];
    pickerGroupName = uiGroupName;
    pickerGeneration = generation;
    pickerNodes = activeGroupAll.map((/** @type {string} */ name) => ({
        name,
        type: proxyMap[name]?.type || 'Unknown',
        host: hostMap[name]?.server ? `${hostMap[name].server}:${hostMap[name].port || ''}` : '',
        lat: 0,
    }));
    activeNodeIdx = pickerNodes.findIndex(n => n.name === currentNodeName);

    return { currentNodeName, proxyMap, hostMap };
}

/**
 * Refresh node data from the backend.
 * @param {{ forceInvalidate?: boolean }} [opts] - pass forceInvalidate:true after
 *   subscription switch or CONFIG_UPDATED to bypass cache TTL.
 */
async function refreshNodeData({ forceInvalidate = false } = {}) {
    if (!isActive) return;
    if (_refreshInFlight) {
        // Record this request so it can be replayed after the current one settles.
        _refreshQueued = true;
        _refreshQueuedForce = _refreshQueuedForce || forceInvalidate;
        return;
    }
    _refreshInFlight = true;
    try {
    // Cancel any pending retry — this call supersedes it
    if (nodeRetryTimer) { clearTimeout(nodeRetryTimer); nodeRetryTimer = null; }

    let success = false;
    // Delays read before a restart or config change belong to the old servers.
    const generation = latencyGeneration;
    const selectionRevision = nodeSelectionRevision;
    try {
        // Only invalidate caches when explicitly requested (subscription switch,
        // CONFIG_UPDATED). Normal refreshes rely on cache TTL/coalescing to
        // avoid redundant IPC/API churn.
        if (forceInvalidate) {
            invalidateProxiesCache();
            invalidateRunConfigCache();
        }

        // 1. Reuse syncCoreConfig() — the same function the home page uses
        //    to sync mode, TUN, and #current-node-name.
        await syncCoreConfig();

        const preferredGroupName = appStore.get('uiGroupName') || null;
        const proxyGroupsResult = await fetchProxyGroups({ preferredGroupName });

        if (!proxyGroupsResult) {
            scheduleNodeRetry();
            return;
        }

        const built = await buildPickerFromProxyGroups(proxyGroupsResult, generation, preferredGroupName, selectionRevision);
        if (!built || selectionRevision !== nodeSelectionRevision || generation !== latencyGeneration) {
            // Fetched before a restart or config change: drop it (its history
            // would bring back the old servers' delays) and read again.
            _refreshQueued = true;
            _refreshQueuedForce = true;
            return;
        }
        const { currentNodeName, proxyMap, hostMap } = built;

        // Update node card
        renderNodeCard(currentNodeName, proxyMap, hostMap);

        // Consider success only if we got a real node name to display
        success = !!currentNodeName;

        // If proxy-providers are still loading (no nodes yet), retry to
        // populate the picker once they finish downloading.
        if (!success && proxyGroupsResult.hasProxyProviders) {
            scheduleNodeRetry();
            return;
        }
    } catch (e) {
        consoleLogger.warn('Failed to refresh node data', e);
    }

    if (success) {
        nodeRetryCount = 0;
    } else {
        scheduleNodeRetry();
    }
    } finally {
        _refreshInFlight = false;
        // Replay a queued request if one came in during the in-flight call.
        // This must be inside finally so early returns don't skip it.
        if (_refreshQueued) {
            _refreshQueued = false;
            const force = _refreshQueuedForce;
            _refreshQueuedForce = false;
            refreshNodeData({ forceInvalidate: force }).catch(() => {});
        }
    }
}

/**
 * Schedule a retry for refreshNodeData with exponential backoff.
 * Resets retry count on deactivate / successful activate.
 */
function scheduleNodeRetry() {
    if (!isActive) return;
    if (nodeRetryCount >= NODE_RETRY_DELAYS.length) {
        nodeRetryCount = 0;
        // The node data never came back: stop the spinner rather than leave
        // it running, with the last value seen for the shown node if any.
        if (latencyStatus === 'pending') {
            const seen = latencyByNode.get($('dz-node-name')?.dataset.leaf || '');
            if (seen) renderLatency(seen.delay);
            else renderLatency(0, 'none');
        }
        if (pickerGeneration !== latencyGeneration) {
            const list = $('dz-picker-list');
            if (list) list.textContent = t('failedToConnect');
        }
        return; // exhausted retries — give up silently
    }
    const delay = NODE_RETRY_DELAYS[nodeRetryCount++];
    nodeRetryTimer = setTimeout(() => {
        nodeRetryTimer = null;
        void refreshNodeData();
    }, delay);
}

// resolveLeafNode is imported from proxies.js to avoid duplication.

/**
 * @param {string} nodeName
 * @param {Record<string, any>} proxies
 * @param {Record<string, {server?: string, port?: number|string}>} [hostMap]
 */
function renderNodeCard(nodeName, proxies, hostMap = {}) {
    _lastNodeArgs = [nodeName, proxies, hostMap];
    // Resolve to leaf node (nodeName may be a group like "♻️ 自动选择")
    const leafName = resolveLeafNode(nodeName, proxies) || nodeName;
    void renderNodeIp(leafName || nodeName);
    const node = proxies[leafName] || proxies[nodeName];
    const host = hostMap[leafName] || hostMap[nodeName];
    paintNodeIdentity(nodeName, leafName, node, host);

    // Latency from proxy history or the newer measurement from this card.
    showNodeLatency(leafName || nodeName || '', node);
    renderPicker();
}

/** @param {string} nodeName @param {string} leafName @param {any} node @param {{server?:string, port?:number|string}|undefined} host */
function paintNodeIdentity(nodeName, leafName, node, host) {
    const nameEl = $('dz-node-name');
    const hostEl = $('dz-node-host');
    const typeEl = $('dz-node-type');
    if (nameEl) {
        nameEl.textContent = (leafName && leafName !== nodeName) ? `${nodeName} - ${leafName}` : (leafName || nodeName || '—');
        nameEl.dataset.leaf = leafName || nodeName || '';
    }
    if (hostEl) hostEl.textContent = host?.server ? `${host.server}:${host.port || ''}` : '';
    if (typeEl) typeEl.textContent = node?.type || '—';

}

/** @type {[string, Record<string, any>, Record<string, {server?: string, port?: number|string}>] | null} */
let _lastNodeArgs = null;

/** Most lower-latency nodes the node card lists; ones that do not fit are hidden. */
const CONSOLE_ALTS = 3;

/**
 * List the selected group's fastest other nodes under the node card.
 * @param {Record<string, any>} proxies
 * @param {string} leaf
 */
function renderNodeAlts(proxies, leaf) {
    const wrap = $('dz-node-alts');
    const list = $('dz-node-alts-list');
    if (!wrap || !list) return;
    const group = pickerGeneration === latencyGeneration ? pickerGroupName : '';
    const effective = (latencyStatus === 'value' || latencyStatus === 'timeout') && $('dz-node-name')?.dataset.leaf === leaf
        ? { ...proxies, [leaf]: { ...proxies[leaf], history: [{ delay: latencyStatus === 'value' ? state.latency : 0 }] } } : proxies;
    const alts = group ? lowerLatencyNodes(effective, group, leaf, CONSOLE_ALTS) : [];
    wrap.hidden = alts.length === 0;
    // A refresh must not take keyboard focus away from the row it rebuilds.
    const focused = /** @type {HTMLElement | null} */ (list.contains(document.activeElement) ? document.activeElement : null);
    const focusedNode = focused?.dataset?.node ?? null;
    list.replaceChildren();
    for (const alt of alts) {
        const { flag, label } = splitFlag(alt.name);
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'dz-alt';
        btn.dataset.node = alt.name;
        btn.dataset.group = group;
        btn.title = t('homeSwitchTo', { name: alt.name });
        if (flag) {
            const f = document.createElement('span');
            f.className = 'home-alt-flag';
            f.setAttribute('aria-hidden', 'true');
            f.textContent = flag;
            btn.append(f);
        }
        const n = document.createElement('span');
        n.className = 'home-alt-name';
        n.textContent = label;
        const ms = document.createElement('span');
        ms.className = 'home-alt-ms';
        ms.textContent = `${alt.delay} ms`;
        btn.append(n, ms);
        list.append(btn);
        if (focusedNode !== null && alt.name === focusedNode) btn.focus({ preventScroll: true });
    }
    fitNodeAlts();
    if (focusedNode !== null && !alts.some((alt) => alt.name === focusedNode)) $('dz-node-picker-btn')?.focus({ preventScroll: true });
}

/** Hide trailing lower-latency rows that would overflow the node card (never half a row). */
function fitNodeAlts() {
    const wrapper = $('dz-node-alts');
    const card = wrapper?.closest('.glass-card');
    const rows = /** @type {HTMLElement[]} */ (Array.from(document.querySelectorAll('#dz-node-alts-list .dz-alt')));
    if (wrapper) wrapper.hidden = rows.length === 0;
    rows.forEach((r) => { r.hidden = false; });
    if (!card || !document.documentElement.classList.contains('dz-wide')) return;
    let overflow = card.scrollHeight - card.clientHeight - 1;
    const bottoms = rows.map((r) => r.offsetTop + r.offsetHeight);
    let firstHidden = rows.length;
    for (let i = rows.length - 1; i >= 0 && overflow > 0; i--) {
        overflow -= i > 0 ? bottoms[i] - bottoms[i - 1] : rows[i].offsetHeight;
        firstHidden = i;
    }
    if (rows.slice(firstHidden).some((row) => row.contains(document.activeElement))) {
        (firstHidden > 0 ? rows[firstHidden - 1] : $('dz-node-picker-btn'))?.focus({ preventScroll: true });
    }
    rows.forEach((r, i) => { r.hidden = i >= firstHidden; });
    if (wrapper) wrapper.hidden = firstHidden === 0;
}

/** Bumped by every renderNodeIp: an older lookup must not draw over a newer one. */
let nodeIpAsk = 0;

/**
 * Drop the shown exit address (core restarted): another profile can have a
 * node of the same name, so the old address must not stay beside it.
 */
function forgetNodeIp() {
    nodeIpAsk++;
    pendingNodeIpResume?.();
    pendingNodeIpResume = null;
    // The node gets its one later try again after this.
    nodeIpRetryLeaf = '';
    if (nodeIpRetryTimer) clearTimeout(nodeIpRetryTimer);
    nodeIpRetryTimer = null;
    const el = $('dz-node-ip');
    if (!el) return;
    const ownsFocus = isActive && (el.contains(document.activeElement)
        || (el.dataset.leaf && document.querySelector('.nd-pop')?.contains(document.activeElement)));
    if (el.dataset.leaf) closeNodeDetails();
    el.replaceChildren();
    el.hidden = true;
    delete el.dataset.leaf;
    if (ownsFocus) $('dz-node-picker-btn')?.focus({ preventScroll: true });
}

/** The node whose one later lookup was scheduled (a node gets one per visit). */
let nodeIpRetryLeaf = '';
/** @type {ReturnType<typeof setTimeout> | null} */
let nodeIpRetryTimer = null;
/** @type {(() => void) | null} */
let pendingNodeIpResume = null;
/** A lookup that found nothing (a network hiccup) is tried once more, after this. */
const NODE_IP_RETRY_MS = 30_000;

/** @param {string} leaf */
function resumeNodeIpWhenIdle(leaf) {
    pendingNodeIpResume?.();
    pendingNodeIpResume = scheduleLatencyRetry(() => {
        pendingNodeIpResume = null;
        if (!isActive || $('dz-node-ip')?.dataset.leaf !== leaf) return;
        if (isSpeedTestBusy()) { resumeNodeIpWhenIdle(leaf); return; }
        void renderNodeIp(leaf);
    });
}

/**
 * After a lookup found nothing, look `leaf` up once more later while it is
 * still the node shown (the minimal home does the same for its own line).
 * @param {string} leaf
 */
function scheduleNodeIpRetry(leaf) {
    // Hidden: nothing to show it on, and an armed marker would block the
    // retry when the page comes back to this node.
    if (!isActive || !leaf || nodeIpRetryLeaf === leaf) return;
    nodeIpRetryLeaf = leaf;
    if (nodeIpRetryTimer) clearTimeout(nodeIpRetryTimer);
    nodeIpRetryTimer = setTimeout(() => {
        nodeIpRetryTimer = null;
        if (!isActive) {
            // Not spent: the next visit to this node may arm it again.
            if (nodeIpRetryLeaf === leaf) nodeIpRetryLeaf = '';
            return;
        }
        if ($('dz-node-ip')?.dataset.leaf !== leaf) return;
        retryFailedExitIp(leaf);
        if (isSpeedTestBusy()) { resumeNodeIpWhenIdle(leaf); return; }
        void renderNodeIp(leaf);
    }, NODE_IP_RETRY_MS);
}

/**
 * The exit address line under the node name, when "show IP address" is on.
 * @param {string} leaf
 */
async function renderNodeIp(leaf) {
    if (!isActive) return;
    const el = $('dz-node-ip');
    if (!el) return;
    const ask = ++nodeIpAsk;
    // Another node: its predecessor's address must not stay beside the new name.
    if (el.dataset.leaf !== leaf) {
        if (el.dataset.leaf) closeNodeDetails();
        el.replaceChildren();
        el.hidden = true;
    }
    // Another node: it gets its own later try.
    if (nodeIpRetryLeaf && nodeIpRetryLeaf !== leaf) {
        nodeIpRetryLeaf = '';
        if (nodeIpRetryTimer) clearTimeout(nodeIpRetryTimer);
        nodeIpRetryTimer = null;
    }
    el.dataset.leaf = leaf;
    if (isSpeedTestBusy()) { resumeNodeIpWhenIdle(leaf); return; }
    const r = leaf ? await exitIpFor(leaf) : null;
    // A later render (another node, the setting turned off) wins.
    if (!isActive || ask !== nodeIpAsk) return;
    if ($('dz-node-name')?.dataset.leaf && $('dz-node-name')?.dataset.leaf !== leaf) return;
    if (!r) {
        if (isSpeedTestBusy()) { resumeNodeIpWhenIdle(leaf); return; }
        el.replaceChildren();
        el.hidden = true;
        dropOrphanedNodeDetails();
        fitNodeAlts();
        scheduleNodeIpRetry(leaf);
        return;
    }
    const summary = exitIpSummary(r);
    // The same address again: keep the button (and its focus).
    const shown = /** @type {HTMLElement | null} */ (el.querySelector('.home-ip-btn'));
    if (shown && shown.dataset.leaf === leaf && shown.dataset.key === exitIpKey(summary)) {
        setExitIpButtonInfo(shown, r);
        shown.title = [summary.title, t('nodeDetailsView')].filter(Boolean).join('\n');
        el.hidden = false;
        return;
    }
    const btn = exitIpButton(summary, leaf, r);
    const keepFocus = shown?.contains(document.activeElement);
    el.replaceChildren(btn);
    if (keepFocus) btn.focus({ preventScroll: true });
    // Only once the old line is gone does the open card move to the new one.
    adoptNodeDetails(btn, leaf);
    el.hidden = false;
    // The card's box keeps its size, so no resize tells the rows to refit.
    fitNodeAlts();
}

/**
 * Wide windows (≥ 1081 px): the subscription card sits in the bottom row
 * beside connections and events, so the right column holds only the node
 * card and the traffic card is not stretched by two side cards. Narrower:
 * under the node card, as before.
 * @returns {() => void}
 */
function placeSubCard() {
    const card = $('dz-sub-card');
    const side = document.querySelector('.dz-side');
    const bottom = document.querySelector('.dz-grid-bottom');
    if (!card || !side || !bottom) return () => {};
    const root = document.documentElement;
    const place = () => {
        const scale = Number.parseFloat(getComputedStyle(root).getPropertyValue('--ui-scale')) || 1;
        const width = window.innerWidth / scale;
        const wide = width > 1080;
        root.classList.toggle('dz-wide', wide);
        root.classList.toggle('dz-compact-layout', !wide);
        root.classList.toggle('dz-three-columns', wide && width < 1280);
        const parent = wide ? bottom : side;
        if (card.parentElement !== parent) {
            const focused = card.contains(document.activeElement) ? /** @type {HTMLElement|null} */ (document.activeElement) : null;
            parent.append(card);
            focused?.focus({ preventScroll: true });
        }
        card.style.flex = wide ? '' : '1';
        fitNodeAlts();
    };
    place();
    window.addEventListener('resize', place);
    const scaleObserver = new MutationObserver(place);
    scaleObserver.observe(root, { attributes: true, attributeFilter: ['style'] });
    const nodeCard = $('dz-node-alts')?.closest('.glass-card');
    const ro = nodeCard && typeof ResizeObserver === 'function' ? new ResizeObserver(() => requestAnimationFrame(fitNodeAlts)) : null;
    if (ro && nodeCard) ro.observe(nodeCard);
    return () => {
        window.removeEventListener('resize', place);
        scaleObserver.disconnect();
        ro?.disconnect();
        root.classList.remove('dz-wide', 'dz-compact-layout', 'dz-three-columns');
    };
}

function renderPicker() {
    const subsEl = $('dz-picker-subs');
    const listEl = $('dz-picker-list');
    if (!subsEl || !listEl) return;

    // Tabs: subscription configs (same data source as the subscriptions page)
    subsEl.replaceChildren();
    for (const sub of subConfigs) {
        const btn = document.createElement('button');
        btn.className = 'dz-picker-sub' + (sub.active ? ' active' : '');
        btn.textContent = sub.active ? `${sub.name} · ${pickerNodes.length}` : sub.name;
        if (!sub.active) {
            btn.addEventListener('click', async () => {
                if (appStore.get('isNetworkUpdating')) return;
                appStore.set('isNetworkUpdating', true);
                btn.disabled = true;
                btn.textContent = sub.name + ' …';
                try {
                    const cfgSettings = await getSettingsCached();
                    await switchToConfig(sub.file, cfgSettings?.custom_args || []);
                    // Keep picker open — user may want to select a node in the
                    // newly loaded subscription, or verify the switch succeeded.
                    // Caches are invalidated by postRestartRecovery, and CONFIG_UPDATED
                    // event will trigger refreshNodeData + refreshSubscriptionData.
                    // But also refresh explicitly in case the event was already handled
                    // or the console is the active page.
                    invalidateProxiesCache();
                    invalidateRunConfigCache();
                    invalidateSettingsCache();
                    invalidateConfigsCache();
                    await refreshNodeData({ forceInvalidate: true });
                    await refreshSubscriptionData();
                } catch (e) {
                    consoleLogger.warn('Failed to switch subscription', e);
                    btn.disabled = false;
                    btn.textContent = sub.name;
                } finally {
                    appStore.set('isNetworkUpdating', false);
                }
            });
        }
        subsEl.appendChild(btn);
    }

    // Node list: nodes from the currently active subscription
    listEl.replaceChildren();
    if (pickerGeneration !== latencyGeneration) {
        listEl.textContent = t('loadingNodes');
        return;
    }
    if (pickerNodes.length === 0) return;

    // Set up delegated event listeners once on the container
    if (!listEl.dataset.delegated) {
    on(listEl, 'click', (/** @type {Event} */ ev) => {
            const target = /** @type {HTMLElement|null} */ (ev.target);
            const row = /** @type {HTMLElement|null} */ (target ? target.closest('.dz-picker-node') : null);
            if (row && listEl.contains(row)) {
                const idx = Number(row.dataset.idx);
                if (Number.isInteger(idx)) void selectPickerNode(idx);
            }
        });
            on(listEl, 'keydown', (/** @type {KeyboardEvent} */ ev) => {
            const target = /** @type {HTMLElement|null} */ (ev.target);
            const row = /** @type {HTMLElement|null} */ (target ? target.closest('.dz-picker-node') : null);
            if (row && listEl.contains(row) && (ev.key === 'Enter' || ev.key === ' ')) {
                ev.preventDefault();
                const idx = Number(row.dataset.idx);
                if (Number.isInteger(idx)) void selectPickerNode(idx);
            }
        });
        listEl.dataset.delegated = '1';
    }

    for (let i = 0; i < pickerNodes.length; i++) {
        const n = pickerNodes[i];
        const row = document.createElement('div');
        row.className = 'dz-picker-node' + (i === activeNodeIdx ? ' active' : '');
        row.setAttribute('role', 'option');
        row.setAttribute('aria-selected', String(i === activeNodeIdx));
        row.tabIndex = 0;
        row.dataset.idx = String(i);
        const main = document.createElement('div');
        main.className = 'dz-picker-node-main';
        const nameDiv = document.createElement('div');
        nameDiv.className = 'dz-picker-node-name';
        nameDiv.textContent = n.name;
        const metaDiv = document.createElement('div');
        metaDiv.className = 'dz-picker-node-meta';
        metaDiv.textContent = `${n.host || n.type} · ${n.type}`;
        main.append(nameDiv, metaDiv);
        const badge = document.createElement('span');
        badge.className = 'type-badge';
        badge.textContent = n.type;
        const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
        svg.setAttribute('class', 'dz-picker-check');
        svg.setAttribute('viewBox', '0 0 24 24');
        svg.setAttribute('fill', 'none');
        svg.setAttribute('stroke', 'currentColor');
        svg.setAttribute('stroke-width', '2.5');
        svg.setAttribute('stroke-linecap', 'round');
        svg.setAttribute('stroke-linejoin', 'round');
        const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
        path.setAttribute('d', 'M20 6 9 17l-5-5');
        svg.appendChild(path);
        row.append(main, badge, svg);
        listEl.appendChild(row);
    }
}

/**
 * Select a picker node by index — extracted for event delegation.
 * @param {number} i
 * @param {string} [drawnGroup] group whose rows supplied this click
 */
async function selectPickerNode(i, drawnGroup = pickerGroupName) {
    const n = pickerNodes[i];
    if (!n) return;
    const currentGroup = appStore.get('uiGroupName') || '';
    if (!drawnGroup || drawnGroup !== pickerGroupName || drawnGroup !== currentGroup || pickerGeneration !== latencyGeneration) return;
    const drawnGeneration = pickerGeneration;
    // A pending mode switch or profile change may carry the previous node over and undo this.
    if (appStore.get('isNetworkUpdating')) {
        showNotification(t('consoleSubUpdateBusy'), 'info');
        return;
    }
    try {
        const targetGroup = drawnGroup;
        // The profile the click was made under, read in the switch's turn so
        // a later click cannot go out first: a profile switch while the
        // request runs must not file this node under the one that replaced it.
        const coreAtClick = coreReplacements();
        const networkUnchanged = noNetworkChangeSince();
        const { ok: success, reason, maybeApplied, unchanged, prepared: profileAtClick = '', seq: switchSeq } = await switchProxyResult(targetGroup, n.name, {
            prepare: profileForSwitch,
            skipIfCurrent: true,
            // A change that began meanwhile could carry its own node over
            // this switch, or take it to the core that replaces this one.
            canSend: () => networkUnchanged() && drawnGeneration === latencyGeneration && pickerGroupName === targetGroup && appStore.get('uiGroupName') === targetGroup,
        });
        if (unchanged) { setPicker(false); void refreshNodeData(); return; }
        if (reason === SWITCH_BUSY) {
            showNotification(t('consoleSubUpdateBusy'), 'info');
            setPicker(false);
            return;
        }
        if (!success) {
            notifySwitchFailed(reason, maybeApplied);
            return;
        }
        // Switch succeeded — post-switch steps are non-critical.
        invalidateProxiesCache();
        // A core that replaced the one switched (a restart meanwhile) runs
        // its own selection: its connections stay, nothing is recorded, and
        // the picker does not mark this click's node as its selection.
        if (coreReplacements() !== coreAtClick || !networkUnchanged()) {
            setPicker(false);
            return;
        }
        // A later switch the core took (any surface, any group) closed the
        // connections itself: closing them again would cut the ones on its
        // node, and the picker (maybe rebuilt for that group) does not mark
        // this click's node. It follows what the core runs.
        if (!isLatestSwitch(targetGroup, switchSeq)) {
            syncCoreConfig().catch(() => {});
            setPicker(false);
            return;
        }
        // The picker's list may now be another group's (the group changed
        // while the switch ran): a node of the same name there is not the
        // one switched, so nothing is marked until the picker reads it.
        const indexInPicker = () => ((appStore.get('uiGroupName') || '') === targetGroup
            ? pickerNodes.findIndex((p) => p.name === n.name)
            : -1);
        // The switch landed: the picker marks its node now, so clicking the
        // node it left while the connections close sends that switch.
        activeNodeIdx = indexInPicker();
        // A later switch or a restart takes the mark back off this node:
        // with nothing marked, a click on this node sends its switch again
        // until the picker reads what the core runs.
        const unmark = () => {
            // Only this group's mark: another group's node of the same name
            // keeps its own.
            if ((appStore.get('uiGroupName') || '') === targetGroup
                && pickerNodes[activeNodeIdx]?.name === n.name) activeNodeIdx = -1;
        };
        try {
            await closeAllConnections();
        } catch (e) {
            consoleLogger.warn('Failed to close connections after node switch', e);
        }
        // Replaced while the connections closed: the switch is not recorded
        // for, nor announced on, the core that runs now.
        if (coreReplacements() !== coreAtClick || !networkUnchanged()) {
            unmark();
            setPicker(false);
            return;
        }
        try {
            const profileName = await profileForSwitch();
            // Rapid clicks can finish out of order: only the newest switch
            // that can stand, from any surface, is recorded.
            if (profileName && profileName === profileAtClick && networkUnchanged() && isLatestSwitch(targetGroup, switchSeq)) {
                await saveProxySelection(profileName, { node: n.name, group: targetGroup });
            }
        } catch (e) { consoleLogger.warn('Failed to save proxy selection', e); }
        // A later switch or a restart meanwhile owns what is announced now.
        if (coreReplacements() !== coreAtClick || !networkUnchanged() || !isLatestSwitch(targetGroup, switchSeq)) {
            unmark();
            setPicker(false);
            void syncCoreConfig().catch(() => {});
            return;
        }
        // The list may have been redrawn while the switch ran: the node is
        // found again by name, not by its old position.
        activeNodeIdx = indexInPicker();
        Bus.emit(Events.PROXY_SELECTED, { node: n.name, group: targetGroup });
        try {
            await syncCoreConfig();
        } catch (e) {
            consoleLogger.warn('Failed to sync core config after node switch', e);
        }
    } catch (e) {
        consoleLogger.warn('Failed to switch node', e);
        notifySwitchFailed(e);
    }
    renderPicker();
    setPicker(false);
}

// ── Picker open/close ────────────────────────────────────────────────────

/** @param {boolean} open */
function setPicker(open) {
    if (open && pickerGeneration !== latencyGeneration) void refreshNodeData({ forceInvalidate: true });
    const pickerEl = $('dz-node-picker');
    const pickerBtn = $('dz-node-picker-btn');
    if (!open && pickerEl && pickerEl.contains(document.activeElement) && pickerBtn) {
        // Return focus to the toggle button when the picker closes
        pickerBtn.focus();
    }
    if (pickerEl) pickerEl.classList.toggle('dz-hidden', !open);
    if (pickerBtn) {
        pickerBtn.classList.toggle('open', open);
        pickerBtn.setAttribute('aria-expanded', String(open));
    }
}

// ── Subscription card ────────────────────────────────────────────────────

/** @type {any} */
let _subConfig = null;
let subscriptionUpdatePending = false;

/** Bumped by every refreshSubscriptionData: an older one must not draw over a newer one. */
let subAsk = 0;

function forgetSubscriptionData() {
    subAsk++;
    _subConfig = null;
    renderSubscriptionCard();
}

async function refreshSubscriptionData() {
    if (!isActive) return;
    const ask = ++subAsk;
    try {
        const settings = await getSettingsCached();
        // A newer refresh already ran: these settings may be the old profile's.
        if (ask !== subAsk) return;
        const currentConfig = currentProfile(settings);
        // Another profile now: the old one's figures and Update Now go until
        // its own are read (a failed read must not leave them acting on it).
        if (_subConfig && _subConfig.name !== currentConfig) {
            _subConfig = null;
            renderSubscriptionCard();
        }
        const configs = await invoke(COMMANDS.LIST_CONFIGS);
        if (ask !== subAsk) return;
        const subscriptionConfigs = (configs || []).filter((/** @type {any} */ c) => c.url_display);
        // Only the active profile's figures: the card sits under the profile
        // menu that names it, so another subscription's would read as its own.
        _subConfig = subscriptionConfigs.find((/** @type {any} */ c) => c.name === currentConfig) || null;
        renderSubscriptionCard();
    } catch (e) {
        if (ask === subAsk) forgetSubscriptionData();
        consoleLogger.warn('Failed to fetch subscription data', e);
    }
}

/**
 * Format a relative time string for the last update.
 * @param {number | null | undefined} timestamp - Unix timestamp in seconds
 * @returns {string}
 */
function fmtRelativeTime(timestamp) {
    if (!timestamp) return t('consoleSubNever');
    const diff = Math.floor(Date.now() / 1000) - timestamp;
    if (diff < 60) return t('consoleSubJustNow');
    if (diff < 3600) return t('consoleSubMinAgo', { m: String(Math.floor(diff / 60)) });
    if (diff < 86400) return t('consoleSubHoursAgo', { h: String(Math.floor(diff / 3600)) });
    return t('consoleSubDaysAgo', { d: String(Math.floor(diff / 86400)) });
}

/**
 * Render quota (used / total) into the card elements.
 * @param {number} used
 * @param {number} total
 */
function renderQuota(used, total) {
    const usedValEl = $('dz-sub-used-val');
    const usedLabelEl = $('dz-sub-used-label');
    const progressEl = $('dz-sub-progress');
    if (total > 0) {
        const pct = Math.min(100, Math.max(0, (used / total) * 100));
        // "102 GB / 200 GB used": both figures carry the unit; under 1 GB in MB,
        // as the profile menu shows it.
        if (usedValEl) usedValEl.textContent = gb(used);
        if (usedLabelEl) usedLabelEl.textContent = `/ ${gb(total)} ${t('consoleSubUsed')}`;
        if (progressEl) progressEl.style.width = pct + '%';
    } else {
        if (usedValEl) usedValEl.textContent = '—';
        if (usedLabelEl) usedLabelEl.textContent = '';
        if (progressEl) progressEl.style.width = '0%';
    }
}

/**
 * Render expiry date into the card element.
 * @param {number} expireTs - Unix timestamp in seconds
 */
function renderExpiry(expireTs) {
    const expiryEl = $('dz-sub-expiry');
    if (!expiryEl) return;
    if (expireTs > 0) {
        const d = new Date(expireTs * 1000);
        const dateStr = new Intl.DateTimeFormat(uiLocale(), {
            year: 'numeric', month: '2-digit', day: '2-digit',
        }).format(d);
        // Rounded up, as the profile menu and subscription list show it.
        const diffDays = Math.ceil((expireTs - Date.now() / 1000) / 86400);
        expiryEl.textContent = diffDays > 0 ? `${dateStr} · ${t('consoleSubDaysLeft', diffDays, { d: String(diffDays) })}` : dateStr;
    } else {
        expiryEl.textContent = '—';
    }
}

/**
 * Render next auto-update time into the card element.
 * @param {{ last_updated?: number, auto_update_interval?: number }} cfg
 */
function renderNextUpdate(cfg) {
    const nextEl = $('dz-sub-next');
    if (!nextEl) return;
    const interval = cfg.auto_update_interval || 0;
    if (interval > 0 && cfg.last_updated) {
        const nextTs = (cfg.last_updated + interval) * 1000;
        const nextDate = new Date(nextTs);
        const now = new Date();
        const isSameDay = nextDate.getFullYear() === now.getFullYear()
            && nextDate.getMonth() === now.getMonth()
            && nextDate.getDate() === now.getDate();
        /** @type {Intl.DateTimeFormatOptions} */
        const timeOpts = { hour: '2-digit', minute: '2-digit' };
        nextEl.textContent = isSameDay
            ? new Intl.DateTimeFormat(uiLocale(), timeOpts).format(nextDate)
            : new Intl.DateTimeFormat(uiLocale(), { month: 'numeric', day: 'numeric', ...timeOpts }).format(nextDate);
    } else {
        nextEl.textContent = '—';
    }
}

/**
 * Render the empty-state placeholder for the subscription card.
 * @param {HTMLElement | null} nameEl
 * @param {HTMLElement | null} updatedEl
 * @param {HTMLButtonElement | null} updateBtn
 */
function renderEmptySubscriptionCard(nameEl, updatedEl, updateBtn) {
    if (nameEl) nameEl.textContent = t('consoleSubNoSub');
    const usedValEl = $('dz-sub-used-val');
    const usedLabelEl = $('dz-sub-used-label');
    const progressEl = $('dz-sub-progress');
    const nextEl = $('dz-sub-next');
    const expiryEl = $('dz-sub-expiry');
    if (usedValEl) usedValEl.textContent = '—';
    if (usedLabelEl) usedLabelEl.textContent = '';
    if (progressEl) progressEl.style.width = '0%';
    if (updatedEl) updatedEl.textContent = '—';
    if (nextEl) nextEl.textContent = '—';
    if (expiryEl) expiryEl.textContent = '—';
    if (updateBtn) updateBtn.disabled = true;
}

function renderSubscriptionCard() {
    const nameEl = $('dz-sub-name');
    const updatedEl = $('dz-sub-updated');
    const updateBtn = /** @type {HTMLButtonElement | null} */ ($('dz-sub-update-btn'));

    // Empty state
    if (!_subConfig) {
        renderEmptySubscriptionCard(nameEl, updatedEl, updateBtn);
        return;
    }

    if (updateBtn) updateBtn.disabled = subscriptionUpdatePending;
    if (nameEl) nameEl.textContent = _subConfig.name.replace(/\.(yaml|yml)$/i, '');

    // Parse sub_info once
    const { upload, download, total, expire } = parseSubInfo(_subConfig.sub_info);
    renderQuota(upload + download, total);

    // Last update time + node count
    if (updatedEl) {
        const timeStr = fmtRelativeTime(_subConfig.last_updated);
        const nodeCount = _subConfig.node_count || _subConfig.proxy_count || 0;
        updatedEl.textContent = nodeCount > 0 ? `${timeStr} · ${t('consoleSubNodes', nodeCount, { count: String(nodeCount) })}` : timeStr;
    }

    renderExpiry(expire);
    renderNextUpdate(_subConfig);
}

async function updateSubscription() {
    if (!_subConfig) return;
    if (appStore.get('isNetworkUpdating')) {
        showNotification(t('consoleSubUpdateBusy'), 'info');
        return;
    }
    appStore.set('isNetworkUpdating', true);
    // Read once: a profile switch meanwhile clears _subConfig.
    const subName = _subConfig.name;
    const coreAtClick = coreGeneration;
    try {
        const settings = await invoke(COMMANDS.GET_SETTINGS);
        if (coreAtClick !== coreGeneration || currentProfile(settings) !== subName) {
            forgetSubscriptionData();
            void refreshSubscriptionData();
            return;
        }
        const results = await invoke(COMMANDS.DOWNLOAD_SUB_BATCH, {
            items: [{ name: subName }],
            userAgent: getSubscriptionUserAgent(),
        });
        if (Array.isArray(results) && results.length > 0 && results[0].success) {
            consoleLogger.info('Subscription updated successfully');
            // Invalidate caches so refreshSubscriptionData reads fresh data
            invalidateConfigsCache();
            invalidateSettingsCache();
            // If the updated subscription is the active config, reload the core
            // so the new node list takes effect immediately.
            const cfgSettings = await getSettingsCached();
            if (currentProfile(cfgSettings) === subName) {
                await switchToConfig(subName, cfgSettings?.custom_args || []);
            }
            showNotification(t('consoleSubUpdateOk'), 'success');
        } else {
            const err = results && Array.isArray(results) && results[0]?.error ? results[0].error : 'Unknown error';
            consoleLogger.warn('Subscription update failed:', err);
            showNotification(t('consoleSubUpdateFail') + ': ' + err, 'error');
        }
    } catch (e) {
        consoleLogger.warn('Subscription update error', e);
        showNotification(t('consoleSubUpdateFail') + ': ' + String(e), 'error');
    } finally {
        appStore.set('isNetworkUpdating', false);
    }
}

// ── Log stream ───────────────────────────────────────────────────────────

const MAX_LOG_LINES = 15;

/**
 * @param {{ type: string, message: string, timestamp: string, source?: string }} entry
 */
function pushLog(entry) {
    const el = $('dz-log-list');
    if (!el) return;
    const line = document.createElement('div');
    line.className = 'dz-log-line';
    const time = entry.timestamp || new Date().toLocaleTimeString(uiLocale(), { hour12: false });
    const rawLevel = (entry.type || 'info').toLowerCase();
    // Normalize PrismEvent types (ConfigReloaded, PatchApplied, etc.) to 'info'
    const knownLevels = ['info', 'warn', 'error', 'debug'];
    const level = knownLevels.includes(rawLevel) ? rawLevel : 'info';
    const tag = entry.source || t('consoleSystem');
    const timeSpan = document.createElement('span');
    timeSpan.className = 'dz-log-time';
    timeSpan.textContent = time;
    const levelSpan = document.createElement('span');
    levelSpan.className = `dz-log-level ${level}`;
    levelSpan.textContent = level;
    const msgSpan = document.createElement('span');
    msgSpan.className = 'dz-log-msg';
    msgSpan.textContent = `[${tag}] ${entry.message}`;
    line.append(timeSpan, levelSpan, msgSpan);
    el.prepend(line);
    while (el.children.length > MAX_LOG_LINES) {
        const last = el.lastElementChild;
        if (last) last.remove(); else break;
    }
    // Keep the newest event visible — scroll to top since newest is prepended.
    // Do not reset scrollLeft: the user may have scrolled right to read a long line.
    el.scrollTop = 0;
}

function loadInitialLogs() {
    const events = getExtLogEvents();
    // pushLog prepends, so iterate oldest→newest to leave the newest on top.
    const recent = events.slice(-MAX_LOG_LINES);
    for (const e of recent) pushLog(e);
}

// ── Mode selector sync ───────────────────────────────────────────────────

/** @type {Array<{ seg: HTMLElement | null, slider: HTMLElement | null }>} */
const MODE_SEGS = [
    { seg: null, slider: null },
];

function initModeSegs() {
    MODE_SEGS[0].seg = $('dz-mode-seg');
    MODE_SEGS[0].slider = $('dz-mode-slider');
}

function syncModeSegs(/** @type {string} */ mode) {
    const modes = ['rule', 'global', 'direct'];
    const idx = modes.indexOf(mode.toLowerCase());
    if (idx === -1) return;
    for (const { seg, slider } of MODE_SEGS) {
        if (!seg) continue;
        seg.querySelectorAll('button[data-mode]').forEach((b) => {
            const active = b.getAttribute('data-mode') === modes[idx];
            b.classList.toggle('active', active);
            b.setAttribute('aria-pressed', String(active));
        });
        if (slider) slider.style.transform = `translateX(calc(var(--rtl-sign, 1) * ${idx * 100}%))`;
    }
}

// ── HTML Template ────────────────────────────────────────────────────────

const TEMPLATE = `
<div class="dz-content custom-scrollbar">
    <h2 class="dz-sr-only" data-i18n="consoleTitle">Console</h2>
    <!-- Switch strip: system proxy, mode, TUN (in place of the page title) -->
    <div class="glass-card home-strip dz-strip relative z-10 shrink-0" id="dz-strip">
        <div class="home-strip-cell">
            <span class="home-strip-icon is-accent" aria-hidden="true"><svg class="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/></svg></span>
            <div class="home-strip-text">
                <h3 id="dz-sys-toggle-label" class="home-strip-title" data-i18n="consoleSysProxy">System Proxy</h3>
                <p id="dz-sys-sub" class="home-strip-sub" data-i18n="stateOff">Off</p>
            </div>
            <label class="ios-switch shrink-0"><input type="checkbox" id="dz-sys-toggle" aria-labelledby="dz-sys-toggle-label" aria-describedby="dz-sys-sub"><span class="switch-slider"></span></label>
        </div>
        <div class="home-strip-sep" aria-hidden="true"></div>
        <div class="home-strip-cell is-mode">
            <div class="dz-mode-seg" id="dz-mode-seg" role="group" aria-label="Proxy Mode" data-i18n-aria-label="mode">
                <div class="dz-mode-slider" id="dz-mode-slider"></div>
                <button type="button" data-mode="rule" aria-pressed="true" data-i18n="rule">Rule</button>
                <button type="button" data-mode="global" aria-pressed="false" data-i18n="global">Global</button>
                <button type="button" data-mode="direct" aria-pressed="false" data-i18n="direct">Direct</button>
            </div>
        </div>
        <div class="home-strip-sep" aria-hidden="true"></div>
        <div class="home-strip-cell">
            <span class="home-strip-icon is-rose" aria-hidden="true"><svg class="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="2" y="3" width="20" height="14" rx="2" ry="2"/><line x1="8" y1="21" x2="16" y2="21"/><line x1="12" y1="17" x2="12" y2="21"/></svg></span>
            <div class="home-strip-text">
                <h3 id="dz-tun-toggle-label" class="home-strip-title">TUN</h3>
                <p id="dz-tun-sub" class="home-strip-sub" data-i18n="stateOff">Off</p>
            </div>
            <label class="ios-switch shrink-0"><input type="checkbox" id="dz-tun-toggle" aria-labelledby="dz-tun-toggle-label" aria-describedby="dz-tun-sub"><span class="switch-slider"></span></label>
        </div>
    </div>

    <!-- KPI strip -->
    <div class="dz-kpis">
        <div class="glass-card dz-kpi">
            <div class="dz-kpi-top">
                <span class="dz-kpi-label" data-i18n="consoleDownSpeed">Download Speed</span>
                <span class="dz-kpi-icon" style="background:color-mix(in srgb, var(--zephyr-color-download) 12%, transparent);color:var(--zephyr-color-download);">
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3v12m0 0 5-5m-5 5-5-5"/><path d="M4 21h16"/></svg>
                </span>
            </div>
            <div class="dz-kpi-value"><b id="dz-down-val">0</b><span id="dz-down-unit">KB/s</span><canvas class="dz-spark" id="dz-spark-down"></canvas></div>
            <div class="dz-kpi-foot"><span data-i18n="consolePeak">Peak</span> <span id="dz-down-peak">0 KB/s</span></div>
        </div>
        <div class="glass-card dz-kpi">
            <div class="dz-kpi-top">
                <span class="dz-kpi-label" data-i18n="consoleUpSpeed">Upload Speed</span>
                <span class="dz-kpi-icon" style="background:color-mix(in srgb, var(--zephyr-color-upload) 12%, transparent);color:var(--zephyr-color-upload);">
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 21V9m0 0 5 5m-5-5-5 5"/><path d="M4 3h16"/></svg>
                </span>
            </div>
            <div class="dz-kpi-value"><b id="dz-up-val">0</b><span id="dz-up-unit">KB/s</span><canvas class="dz-spark" id="dz-spark-up"></canvas></div>
            <div class="dz-kpi-foot"><span data-i18n="consolePeak">Peak</span> <span id="dz-up-peak">0 KB/s</span></div>
        </div>
        <div class="glass-card dz-kpi">
            <div class="dz-kpi-top">
                <span class="dz-kpi-label" data-i18n="consoleTotalTraffic">Total Traffic</span>
                <span class="dz-kpi-icon" style="background:rgba(74,222,128,.12);color:var(--zephyr-color-success);">
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M21 12a9 9 0 1 1-9-9"/><path d="M21 3 12 12"/><path d="M16 3h5v5"/></svg>
                </span>
            </div>
            <div class="dz-kpi-value"><b id="dz-total-val">0 B</b></div>
            <div class="dz-kpi-foot">↓ <span id="dz-total-down">0 B</span> · ↑ <span id="dz-total-up">0 B</span></div>
        </div>
        <div class="glass-card dz-kpi dz-kpi-link" id="dz-conn-kpi" role="link" tabindex="0">
            <div class="dz-kpi-top">
                <span class="dz-kpi-label"><span data-i18n="consoleActiveConn">Active Connections</span><svg class="dz-kpi-arrow" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m9 18 6-6-6-6"/></svg></span>
                <span class="dz-kpi-icon" style="background:rgba(245,158,11,.12);color:var(--zephyr-color-warning);">
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><circle cx="5" cy="12" r="2.5"/><circle cx="19" cy="12" r="2.5"/><path d="M7.5 12h9"/></svg>
                </span>
            </div>
            <div class="dz-kpi-value"><b id="dz-conn-val">0</b><span data-i18n="consoleConnUnit">conn</span></div>
            <div class="dz-kpi-foot">TCP <span id="dz-conn-tcp">0</span> · UDP <span id="dz-conn-udp">0</span></div>
        </div>
    </div>

    <!-- Main grid: chart + sidebar -->
    <div class="dz-grid-main">
        <div class="glass-card dz-card-pad dz-traffic-card" id="dz-traffic-card" style="display:flex;flex-direction:column;">
            <div class="dz-card-head">
                <div class="dz-card-title"><span class="dot"></span><span data-i18n="consoleRealtimeTraffic">Real-time Traffic</span></div>
                <div class="dz-legend">
                    <div class="dz-legend-item"><span class="dz-legend-swatch" style="background:color-mix(in srgb, var(--zephyr-color-download) 80%, transparent)"></span><span data-i18n="consoleDownload">Download</span></div>
                    <div class="dz-legend-item"><span class="dz-legend-swatch" style="background:color-mix(in srgb, var(--zephyr-color-upload) 80%, transparent)"></span><span data-i18n="consoleUpload">Upload</span></div>
                </div>
            </div>
            <div class="dz-chart-wrap"><canvas id="dz-chart"></canvas></div>
            <div class="dz-chart-meta">
                <div><span data-i18n="consoleAvgMin">1 min avg</span><b id="dz-avg-down">0 KB/s ↓</b></div>
                <div><span data-i18n="consoleSessionDown">Session DL</span><b id="dz-sess-down">0 B</b></div>
                <div><span data-i18n="consoleSessionUp">Session UL</span><b id="dz-sess-up">0 B</b></div>
            </div>
        </div>

        <div class="dz-side">
            <div class="dz-node-wrap">
                <div class="glass-card dz-card-pad">
                    <div class="dz-card-head" style="margin-bottom:10px;">
                        <div class="dz-card-title"><span class="dot"></span><span data-i18n="consoleCurrentNode">Current Node</span></div>
                        <div style="display:flex;align-items:center;gap:8px;">
                            <span class="type-badge" id="dz-node-type">—</span>
                            <button class="dz-switch-node-btn" id="dz-node-picker-btn" aria-haspopup="listbox" aria-expanded="false" aria-controls="dz-picker-list">
                                <span data-i18n="consoleSwitch">Switch</span>
                                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="m6 9 6 6 6-6"/></svg>
                            </button>
                        </div>
                    </div>
                    <div class="dz-node-name-row">
                        <span class="dz-node-name" id="dz-node-name">—</span>
                    </div>
                    <div class="dz-node-sub">
                        <span style="font-family:var(--font-mono)" id="dz-node-host"></span>
                    </div>
                    <div class="dz-node-ip home-node-sub" id="dz-node-ip" hidden></div>
                    <div class="dz-node-latency">
                        <span class="dz-latency-num" data-lat-state="pending"><span id="dz-node-lat" class="dz-lat-num is-pending"></span><small class="dz-lat-unit">ms</small></span>
                        <span class="latency-badge" id="dz-node-lat-badge" hidden></span>
                        <button class="btn-ghost dz-test-btn" id="dz-test-btn" style="font-size:11px;">
                            <svg class="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" style="width:12px;height:12px;"><path d="M21 12a9 9 0 1 1-9-9c2.52 0 4.93 1 6.74 2.74L21 8"/><path d="M21 3v5h-5"/></svg>
                            <span data-i18n="consoleTestLatency">Test</span>
                        </button>
                    </div>
                    <div class="dz-node-alts" id="dz-node-alts" role="group" aria-labelledby="dz-node-alts-label" hidden>
                        <p id="dz-node-alts-label" data-i18n="homeLowerLatency">Lower latency</p>
                        <div id="dz-node-alts-list"></div>
                    </div>
                </div>
                <div class="dz-node-picker dz-hidden" id="dz-node-picker">
                    <div class="dz-picker-subs" id="dz-picker-subs"></div>
                    <div class="dz-picker-list custom-scrollbar" id="dz-picker-list" role="listbox" aria-label="Node picker"></div>
                </div>
            </div>

        </div>
    </div>

    <!-- Bottom three-column grid -->
    <div class="dz-grid-bottom">
        <div class="glass-card dz-card-pad" style="display:flex;flex-direction:column;min-height:0;">
            <div class="dz-card-head">
                <div class="dz-card-title"><span class="dot"></span><span data-i18n="consoleActiveConn">Active Connections</span></div>
                <button class="dz-sort-btn" id="dz-sort-btn">
                    <span id="dz-sort-label" data-i18n="consoleSortBySpeed">Sort by Speed</span>
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="m7 15 5 5 5-5M7 9l5-5 5 5"/></svg>
                </button>
            </div>
            <div class="dz-conn-list custom-scrollbar" id="dz-conn-list"></div>
        </div>

        <div class="glass-card dz-card-pad dz-sub-card" id="dz-sub-card" style="display:flex;flex-direction:column;overflow:visible;">
            <div class="dz-card-head">
                <div class="dz-card-title"><span class="dot"></span><span data-i18n="consoleSubUsage">Subscription</span></div>
            </div>
            <div id="dz-profile" class="home-profile dz-profile relative"></div>
            <span id="dz-sub-name" hidden>—</span>
            <div class="dz-sub-used"><b id="dz-sub-used-val">—</b><span id="dz-sub-used-label"> / —</span></div>
            <div class="dz-progress"><div class="dz-progress-fill" id="dz-sub-progress" style="width:0%"></div></div>
            <div class="dz-sub-rows">
                <div class="dz-sub-row"><span data-i18n="consoleSubExpiry">Expires</span><b id="dz-sub-expiry">—</b></div>
                <div class="dz-sub-row"><span data-i18n="consoleSubLastUpdate">Last update</span><b id="dz-sub-updated">—</b></div>
                <div class="dz-sub-row"><span data-i18n="consoleSubNextUpdate">Next auto-update</span><b id="dz-sub-next">—</b></div>
            </div>
            <div class="dz-sub-actions">
                <button class="dz-mini-btn accent" id="dz-sub-update-btn">
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M21 12a9 9 0 1 1-9-9c2.52 0 4.93 1 6.74 2.74L21 8"/><path d="M21 3v5h-5"/></svg>
                    <span data-i18n="consoleSubUpdateNow">Update Now</span>
                </button>
                <button class="dz-mini-btn" id="dz-sub-manage-btn" data-i18n="consoleSubManage">Manage</button>
            </div>
        </div>

        <div class="glass-card dz-card-pad" style="display:flex;flex-direction:column;min-height:0;">
            <div class="dz-card-head">
                <div class="dz-card-title"><span class="dot"></span><span data-i18n="consoleRecentEvents">Recent Events</span></div>
                <button class="dz-mini-btn" id="dz-all-logs-btn" style="flex:0;padding:4px 10px;" data-i18n="consoleAllLogs">All Logs</button>
            </div>
            <div class="dz-log-list custom-scrollbar" id="dz-log-list"></div>
        </div>
    </div>
</div>
`;

// ── Initialization ───────────────────────────────────────────────────────

/**
 * Initialize the console home page.
 * Injects HTML, binds events, starts polling.
 * Should be called once during app init.
 */
export function initConsoleHome() {
    if (isInitialized) return;
    const container = document.querySelector('[data-page="console"]');
    if (!container) return;

    // A previous failed attempt may have registered subscribers before
    // throwing. Release them so a retry does not create duplicates.
    _runPendingCleanups();

    try {
        _buildConsoleHome(container);
    } catch (err) {
        // Undo every registration made by the failed attempt.
        _runPendingCleanups();
        throw err;
    }
}

/** Run and discard every pending cleanup. */
function _runPendingCleanups() {
    for (const fn of _cleanups.splice(0)) {
        try { fn(); } catch { /* cleanup must not throw */ }
    }
    for (const unreg of _globalUnregs.splice(0)) {
        try { unreg(); } catch { /* unregister must not throw */ }
    }
}

/**
 * Build the console home page — injects HTML, binds events, starts polling.
 * @param {Element} container
 */
function _buildConsoleHome(container) {
    // Inject template
    // TEMPLATE is a static string with no user input — safe for innerHTML
    // eslint-disable-next-line no-unsanitized/property
    container.innerHTML = TEMPLATE;

    // Translate all data-i18n elements in the injected template
    applyTranslations();
    // The template's spinners get their screen-reader text until a delay arrives.
    if (latencyStatus === 'pending') renderLatency(0, 'pending');

    // No subscription: the traffic card carries the Add entry (same as the minimal hero).
    syncNoSubscriptionState();

    // Set aria-labels and titles (not handled by applyTranslations)
    const pickerListInit = $('dz-picker-list');
    if (pickerListInit) pickerListInit.setAttribute('aria-label', t('consoleNodePicker'));
    const hostInit = $('dz-node-host');
    if (hostInit) hostInit.title = t('consoleCopyHint');

    // Init mode segments
    initModeSegs();

    // ── Mode selector: delegate to home page's data-mode buttons ──
    // The home page's initModeSelector() in modes.js binds the actual
    // patchConfig + node inheritance logic. Console buttons are injected
    // dynamically, so we delegate clicks to the corresponding home page button.
    const consoleModeSeg = $('dz-mode-seg');
    consoleModeSeg?.querySelectorAll('button[data-mode]').forEach((btn) => {
        on(/** @type {EventTarget} */ (btn), 'click', () => {
            const mode = /** @type {HTMLElement} */ (btn).dataset.mode;
            if (!mode) return;
            // Find the home page's corresponding data-mode button and click it
            const homeBtn = document.querySelector(`[data-page="home"] button[data-mode="${mode}"]`);
            if (homeBtn instanceof HTMLElement) {
                homeBtn.click();
            }
        });
    });

    // ── Connection sort ──
    const sortBtn = $('dz-sort-btn');
    if (sortBtn) {
        sortBtn.title = t('consoleSortHint');
        on(sortBtn, 'click', () => {
            sortIdx = (sortIdx + 1) % SORT_MODES.length;
            const label = $('dz-sort-label');
            if (label) label.textContent = t(SORT_MODES[sortIdx].labelKey);
            void pollConnections();
        });
    }

    // ── Node picker ──
    const pickerBtn = $('dz-node-picker-btn');
    if (pickerBtn) on(pickerBtn, 'click', (/** @type {Event} */ e) => {
        e.stopPropagation();
        const pickerEl = $('dz-node-picker');
        if (pickerEl) setPicker(pickerEl.classList.contains('dz-hidden'));
    });

    // Close picker when clicking anywhere outside the picker element itself.
    // Uses capture phase so it fires before any other handler can stopPropagation.
    const _docClickClose = (/** @type {Event} */ e) => {
        const pickerEl = $('dz-node-picker');
        if (!pickerEl || pickerEl.classList.contains('dz-hidden')) return;
        const target = /** @type {Element | null} */ (e.target);
        if (!target) return;
        // Close if the click is outside the picker dropdown AND not on the toggle button
        if (!target.closest('#dz-node-picker') && !target.closest('#dz-node-picker-btn')) {
            setPicker(false);
        }
    };
    on(document, 'click', _docClickClose, true); // ← capture phase

    // ── Node host click-to-copy ──
    const hostCopyEl = $('dz-node-host');
    if (hostCopyEl) {
        hostCopyEl.setAttribute('role', 'button');
        hostCopyEl.tabIndex = 0;
        // One shared restore timer for the copy feedback: a second
        // copy within the 1.2 s window must not capture the feedback
        // color (green, or danger after a failure) as the "original"
        // and restore to it — the first timer would clear the color
        // and the second would put the feedback color back, leaving
        // it stuck. The original color is recorded only while no
        // feedback is pending.
        /** @type {ReturnType<typeof setTimeout> | undefined} */
        let hostCopyTimer;
        /** @type {string} */
        let hostCopyOrig = '';
        // The sequence of the newest host copy requested: feedback
        // belongs to it — an older copy settling after a newer one
        // must not replace the newer feedback (success or failure).
        let latestHostCopySeq = 0;
        const flashHostCopy = (/** @type {string} */ color) => {
            if (hostCopyTimer === undefined) {
                hostCopyOrig = hostCopyEl.style.color;
            } else {
                clearTimeout(hostCopyTimer);
            }
            hostCopyEl.style.color = color;
            hostCopyTimer = setTimeout(() => {
                hostCopyEl.style.color = hostCopyOrig;
                hostCopyTimer = undefined;
            }, 1200);
        };
        const copyHost = () => {
            const text = hostCopyEl.textContent || '';
            if (!text) return;
            const done = () => {
                flashHostCopy('var(--zephyr-color-success)');
            };
            const failed = (/** @type {unknown} */ err) => {
                consoleLogger.warn('Failed to copy node host', err);
                flashHostCopy('var(--zephyr-color-danger)');
            };
            if (navigator.clipboard?.writeText) {
                // The sequence, taken when the write is requested: a
                // direct write that resolves after a newer tray copy
                // must not become the repair target for it.
                const seq = nextClipboardSeq();
                latestHostCopySeq = seq;
                // A hung permission prompt leaves `writeText`
                // unsettled forever: race it so the copy is reported
                // failed instead of the host staying silent.
                withClipboardTimeout(navigator.clipboard.writeText(text), 5000, () => {
                    // A native write that lands after the timeout still
                    // changed the clipboard: record it so a newer copy
                    // it overwrote is repaired back. No feedback here —
                    // the timeout already reported this copy as failed.
                    noteExternalClipboardWrite(text, seq);
                }).then(() => {
                    // This write bypasses copyToClipboard: tell the tray
                    // module the newest copied text, so a repair in flight
                    // re-asserts this text instead of overwriting it with
                    // an older one. The landing is recorded regardless of
                    // feedback: the tracker sorts out ordering, and a newer
                    // copy still pending needs this record if it fails.
                    // Only flash success while this write is still the
                    // newest on the clipboard and the newest host copy
                    // requested: a newer tray copy may have claimed the
                    // record while this write was pending, in which case
                    // the repair already re-asserted that text — and a
                    // newer host copy owns the feedback now.
                    const landedNewest = noteExternalClipboardWrite(text, seq);
                    if (seq === latestHostCopySeq && landedNewest) done();
                }).catch((err) => {
                    // Same ownership for failures: an older copy failing
                    // after a newer one succeeded must not replace the
                    // newer success feedback with danger.
                    if (seq === latestHostCopySeq) failed(err);
                });
            } else {
                failed(new Error('Clipboard API unavailable'));
            }
        };
        on(hostCopyEl, 'click', copyHost);
            on(hostCopyEl, 'keydown', (/** @type {KeyboardEvent} */ ev) => {
            if (ev.key === 'Enter' || ev.key === ' ') {
                ev.preventDefault();
                copyHost();
            }
        });
    }
    const _docKeydown = (/** @type {KeyboardEvent} */ e) => {
        if (e.key === 'Escape') setPicker(false);
    };
    on(document, 'keydown', _docKeydown);

    // ── Test latency button ──
    /**
     * Show the result of a Test click, unless something newer owns the card.
     * @param {string} leafName
     * @param {number} generation the latency generation when the test began
     * @param {number} request the test's request number
     * @param {{ delay: number, cancelled: boolean }} outcome
     */
    const settleLatencyClick = (leafName, generation, request, { delay, cancelled }) => {
        const shown = $('dz-node-name')?.dataset.leaf === leafName;
        // Checked before the request: a restart or config change also drops
        // the request records, and the probe it started was turned away
        // while this test ran.
        if (generation !== latencyGeneration) {
            // Started before a restart or config change: the name may now be
            // another server, so measure that one instead of keeping this.
            if (shown) {
                renderLatency(0, 'pending');
                void probeLatency(leafName);
            }
        } else if (!isLatestLatencyRequest(leafName, request)) {
            if (shown) retrySupersededClick(leafName);
        } else if (!cancelled) {
            showClickResult(leafName, delay, shown);
        } else if (shown) {
            // Stopped by a full test winding down, or the probe this test
            // replaced gave up: the click still asked for a measurement, so
            // take it once that is over, showing that it is waiting.
            if (latencyStatus !== 'pending') renderLatency(0, 'pending');
            retryLatencyLater(leafName);
        }
    };
    /**
     * A newer test of this node shows its own result; with none still
     * running, a card left waiting measures again.
     * @param {string} leafName
     */
    const retrySupersededClick = (leafName) => {
        if (latencyStatus === 'pending' && !manualLatencyTests.has(leafName)
            && !latencyProbes.has(leafName)) retryLatencyLater(leafName);
    };
    /**
     * A stop from a node or config switch is not a timeout: only a finished
     * test is remembered and shown.
     * @param {string} leafName
     * @param {number} delay
     * @param {boolean} shown
     */
    const showClickResult = (leafName, delay, shown) => {
        rememberLatency(leafName, delay);
        if (!shown) return;
        renderLatency(delay);
        // A failed click is retried later, like a failed probe.
        if (delay <= 0) retryFailedLatency(leafName);
    };
    const testBtn = /** @type {HTMLButtonElement | null} */ ($('dz-test-btn'));
        if (testBtn) on(testBtn, 'click', async () => {
        const btn = testBtn;
        const leafName = $('dz-node-name')?.dataset.leaf;
        if (!leafName) return;
        btn.setAttribute('aria-busy', 'true');
        btn.disabled = true;
        const generation = latencyGeneration;
        const request = startLatencyRequest(leafName);
        manualLatencyTests.add(leafName);
        try {
            /** @type {{ delay: number, cancelled: boolean }} */
            let outcome;
            try {
                outcome = await measureLatency(leafName);
            } finally {
                manualLatencyTests.delete(leafName);
            }
            settleLatencyClick(leafName, generation, request, outcome);
        } finally {
            btn.removeAttribute('aria-busy');
            btn.disabled = false;
        }
    });

    // ── Sys proxy / TUN toggle bindings ──
    // Two-way: store → DOM via bind(), DOM → store via change handler
    const sysToggle = /** @type {HTMLInputElement|null} */ ($('dz-sys-toggle'));
    const tunToggle = /** @type {HTMLInputElement|null} */ ($('dz-tun-toggle'));

    if (sysToggle) {
    _cleanups.push(bind(appStore, sysToggle, 'isSysProxyEnabled', 'checked'));
    on(sysToggle, 'change', async () => {
            const enabled = sysToggle.checked;
            // Call the backend directly instead of dispatching a DOM event,
            // which may have no listener if console initialized before sysproxy.js.
            try {
                await setSysProxyEnabled(enabled);
            } catch (e) {
                consoleLogger.warn('Console sys-proxy toggle failed', e);
                const errorPrefix = t('errorPrefix');
                const toggleFailedMsg = t('notifSysProxyToggleFailed');
                showNotification(`${errorPrefix}: ${toggleFailedMsg}`, 'error');
                // Refresh actual backend state instead of assuming !enabled
                await refreshSysProxyStatus().catch(() => {});
                sysToggle.checked = appStore.get('isSysProxyEnabled');
            }
            // Sync the minimal-home toggle so both UIs stay in sync.
            const mainToggle = /** @type {HTMLInputElement | null} */ (document.getElementById('sys-proxy-toggle'));
            if (mainToggle) mainToggle.checked = sysToggle.checked;
        });
    }
    if (tunToggle) {
        // Same flow as the minimal home: the home toggle runs the switch
        // (authorisation, rollback, notices) and this one follows its result,
        // including a failed start that leaves the store unchanged.
        _cleanups.push(mirrorTunToggle(tunToggle));
    }

    // Update proxy/TUN status text

    // ── Mode selector sync ──
    _cleanups.push(appStore.subscribe('currentOutboundMode', (/** @type {string} */ mode) => {
        syncModeSegs(mode);
        forgetNodeIp();
        const leaf = $('dz-node-name')?.dataset.leaf;
        if (isActive && leaf && mode !== 'direct') void renderNodeIp(leaf);
    }));
    syncModeSegs(appStore.get('currentOutboundMode') || 'rule');

    // ── Traffic data via Bus ──
    // raw.up/down are instantaneous bytes/sec per the mihomo /traffic contract
    // (see traffic-chart.js updateTrafficData docs).
    _cleanups.push(Bus.on(Events.TRAFFIC_UPDATE, (/** @type {any} */ data) => {
        const raw = data?.raw;
        if (!raw) return;
        const prevDown = state.down;
        const prevUp = state.up;
        state.down = raw.down || 0;
        state.up = raw.up || 0;

        // Integrate rates into totals using trapezoidal approximation:
        // average of previous and current rates × elapsed time.
        // This avoids right-endpoint bias where a sudden spike gets
        // attributed to the entire previous interval.
        // totalDown/totalUp are lifetime counters — always accumulate.
        // sessDown/sessUp are session-scoped — only when console is active.
        const now = Date.now();
        // Lifetime totals — always accumulate, never reset
        if (lastTrafficTsMsTotal && !hasCoreTotals) {
            const dtSec = Math.max(0, Math.min(5, (now - lastTrafficTsMsTotal) / 1000));
            state.totalDown += (prevDown + state.down) * 0.5 * dtSec;
            state.totalUp += (prevUp + state.up) * 0.5 * dtSec;
        }
        lastTrafficTsMsTotal = now;
        // Session totals — only accumulate while console is active
        if (isActive) {
            if (lastTrafficTsMsSession) {
                const dtSec = Math.max(0, Math.min(5, (now - lastTrafficTsMsSession) / 1000));
                state.sessDown += (prevDown + state.down) * 0.5 * dtSec;
                state.sessUp += (prevUp + state.up) * 0.5 * dtSec;
            }
            lastTrafficTsMsSession = now;
        }

        state.downPeak = Math.max(state.downPeak, state.down);
        state.upPeak = Math.max(state.upPeak, state.up);
        trafficHistory.push({ up: state.up, down: state.down, time: now });
        if (trafficHistory.length > 60) trafficHistory.shift();

        if (!isActive) return;

        renderNumbers();
        // Paint the canvases on the next animation frame. Bursts of samples
        // collapse into a single paint, and nothing is drawn while the
        // webview is not rendering frames; the next sample repaints from the
        // full history, so the visible chart is unchanged.
        if (!trafficRaf) {
            trafficRaf = requestAnimationFrame(() => {
                trafficRaf = 0;
                if (!isActive) return;
                drawChart($('dz-chart'));
                const rgb = trafficRgb();
                drawSpark($('dz-spark-down'), 'down', rgb.down);
                drawSpark($('dz-spark-up'), 'up', rgb.up);
            });
        }
    }));
    _cleanups.push(() => { if (trafficRaf) { cancelAnimationFrame(trafficRaf); trafficRaf = 0; } });

    // ── Theme: drop cached CSS variables used by the chart ──
    _cssVars.invalidate();
    _cleanups.push(Bus.on(Events.THEME_MODE_CHANGED, () => _cssVars.invalidate()));
    _cleanups.push(Bus.on(Events.THEME_CHANGED, () => _cssVars.invalidate()));

    // ── Log stream ──
    loadInitialLogs();
    const _logCb = (/** @type {{ type: string, message: string, timestamp: string, source?: string }} */ entry) => { if (isActive) pushLog(entry); };
    const _unsubLog = subscribeToEvents(_logCb);
    _cleanups.push(_unsubLog);

    // ── Proxy events ──
    _cleanups.push(Bus.on(Events.PROXY_SELECTED, () => {
        nodeSelectionRevision++;
        forgetNodeIp();
        void refreshNodeData();
    }));

    // ── Core restart: reset traffic counters ──
    // CORE_RESTARTED fires when mihomo just started. We reset counters here
    // (not on CONFIG_UPDATED) because CONFIG_UPDATED also fires on non-restart
    // settings changes (restore defaults, node-scroll toggle, etc.).
    const _coreRestartedUnsub = Bus.on(Events.CORE_RESTARTED, () => {
        coreGeneration++;
        setPicker(false);
        pickerNodes = [];
        subConfigs = [];
        pickerGroupName = '';
        pickerGeneration = -1;
        forgetSubscriptionData();
        renderPicker();
        forgetLatencies();
        forgetNodeIp();
        state.totalDown = 0;
        state.totalUp = 0;
        state.downPeak = 0;
        state.upPeak = 0;
        state.sessDown = 0;
        state.sessUp = 0;
        trafficHistory.length = 0;
        // The new core may not report counters yet: fall back to integrating the speed.
        hasCoreTotals = false;
        lastTrafficTsMsTotal = null;
        lastTrafficTsMsSession = null;
    });
    _cleanups.push(() => _coreRestartedUnsub());
    _cleanups.push(Bus.on(Events.DIAGNOSTICS_INVALIDATED, () => {
        setPicker(false);
        forgetLatencies();
        renderLatency(0, 'pending');
        forgetNodeIp();
        _lastNodeArgs = null;
        pickerNodes = [];
        subConfigs = [];
        pickerGroupName = '';
        pickerGeneration = -1;
        $('dz-node-alts-list')?.replaceChildren();
        const alts = $('dz-node-alts');
        if (alts) alts.hidden = true;
        renderPicker();
        if (isActive) void refreshNodeData({ forceInvalidate: true });
    }));

    // ── Config update: refresh all console data ──
    // Listen to CONFIG_UPDATED (emitted after full postRestartRecovery:
    // overrides applied, proxy selection restored, caches invalidated).
    // Also fires on non-restart settings changes — that's fine for data refresh.
    const _configUpdatedUnsub = Bus.on(Events.CONFIG_UPDATED, (/** @type {any} */ data) => {
        // Clear before the first read: a failed read cannot retain the old profile's card.
        forgetSubscriptionData();
        // Node names may now point at other servers: measure them afresh.
        forgetLatencies();
        setPicker(false);
        renderPicker();
        // A reload (an override can re-point a node) drops the old address too.
        if (data?.reloaded || data?.restoreRuntime) {
            // exit-ip.js has already reset the shared cache for this reload.
            forgetNodeIp();
            _lastNodeArgs = null;
            setPicker(false);
            pickerNodes = [];
            subConfigs = [];
            pickerGroupName = '';
            pickerGeneration = -1;
            renderPicker();
            $('dz-node-alts-list')?.replaceChildren();
            const alts = $('dz-node-alts');
            if (alts) alts.hidden = true;
        }
        if (!isActive) return; // skip IPC calls when console page is hidden
        nodeRetryCount = 0; // core fully restarted - give retry budget back
        void refreshNodeData({ forceInvalidate: true });
        void refreshSubscriptionData();
    });
    _cleanups.push(() => _configUpdatedUnsub());

    // ── Resize handler (coalesced with requestAnimationFrame) ──
    let resizeRaf = 0;
    const resizeHandler = () => {
        if (resizeRaf) return;
        resizeRaf = requestAnimationFrame(() => {
            resizeRaf = 0;
            drawChart($('dz-chart'));
        });
    };
    on(window, 'resize', resizeHandler);

    // ── Theme / light-dark switch ──
    // Download/upload colours differ between light and dark, and the canvases
    // only repaint on traffic ticks; repaint now so an idle or disconnected
    // console does not keep the previous mode's colours.
    let themeRaf = 0;
    const repaintForTheme = () => {
        if (!isActive || themeRaf) return;
        themeRaf = requestAnimationFrame(() => {
            themeRaf = 0;
            if (!isActive) return;
            drawChart($('dz-chart'));
            const rgb = trafficRgb();
            drawSpark($('dz-spark-down'), 'down', rgb.down);
            drawSpark($('dz-spark-up'), 'up', rgb.up);
        });
    };
    _cleanups.push(Bus.on(Events.THEME_MODE_CHANGED, repaintForTheme));
    _cleanups.push(Bus.on(Events.THEME_CHANGED, repaintForTheme));
    _cleanups.push(() => { if (themeRaf) { cancelAnimationFrame(themeRaf); themeRaf = 0; } });

    // ── Connection polling ──
    _cleanups.push(() => { if (connPollTimer) { clearInterval(connPollTimer); connPollTimer = null; } });

    // ── Subscription update button ──
    const subUpdateBtn = /** @type {HTMLButtonElement | null} */ ($('dz-sub-update-btn'));
    /**
     * Rebuild the sub-update button content via DOM methods (avoids innerHTML).
     * @param {HTMLButtonElement} btn
     * @param {boolean} loading
     */
    const setSubUpdateBtnState = (btn, loading) => {
        btn.replaceChildren();
        const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
        if (loading) svg.setAttribute('class', 'animate-spin');
        svg.setAttribute('viewBox', '0 0 24 24');
        svg.setAttribute('fill', 'none');
        svg.setAttribute('stroke', 'currentColor');
        svg.setAttribute('stroke-width', '2.5');
        svg.setAttribute('style', 'width:12px;height:12px;');
        const p1 = document.createElementNS('http://www.w3.org/2000/svg', 'path');
        p1.setAttribute('d', 'M21 12a9 9 0 1 1-9-9c2.52 0 4.93 1 6.74 2.74L21 8');
        const p2 = document.createElementNS('http://www.w3.org/2000/svg', 'path');
        p2.setAttribute('d', 'M21 3v5h-5');
        svg.append(p1, p2);
        const span = document.createElement('span');
        span.textContent = loading ? t('consoleSubUpdating') : t('consoleSubUpdateNow');
        btn.append(svg, span);
    };
        if (subUpdateBtn) on(subUpdateBtn, 'click', async () => {
        if (subscriptionUpdatePending) return;
        subscriptionUpdatePending = true;
        const btn = subUpdateBtn;
        setSubUpdateBtnState(btn, true);
        btn.disabled = true;
        try {
            await updateSubscription();
        } finally {
            subscriptionUpdatePending = false;
            setSubUpdateBtnState(btn, false);
            btn.disabled = !_subConfig;
            void refreshSubscriptionData();
        }
    });

    // ── Manage subscription button ──
    const subManageBtn = $('dz-sub-manage-btn');
        if (subManageBtn) on(subManageBtn, 'click', () => {
        const navBtn = document.querySelector('[data-nav="subscriptions"]');
        if (navBtn instanceof HTMLElement) navBtn.click();
    });

    // ── All logs button ──
    const allLogsBtn = $('dz-all-logs-btn');
        if (allLogsBtn) on(allLogsBtn, 'click', () => {
        const navBtn = document.querySelector('[data-nav="logs"]');
        if (navBtn instanceof HTMLElement) navBtn.click();
    });

    // ── Connections KPI: the whole card opens the connections page ──
    const connKpi = $('dz-conn-kpi');
    if (connKpi) {
        const openConns = () => {
            const navBtn = document.querySelector('[data-nav="connections"]');
            if (navBtn instanceof HTMLElement) navBtn.click();
        };
        on(connKpi, 'click', openConns);
        // A link opens on Enter only (Space scrolls, as on any link).
        on(connKpi, 'keydown', (/** @type {KeyboardEvent} */ e) => {
            if (e.key === 'Enter') { e.preventDefault(); openConns(); }
        });
    }

    // ── Strip subtitles: on / off ──
    /** @param {string} id @param {boolean} on */
    const paintState = (id, on) => {
        const el = $(id);
        if (!el) return;
        const key = on ? 'stateOn' : 'stateOff';
        el.dataset.i18n = key;
        el.textContent = t(key);
    };
    paintState('dz-sys-sub', !!appStore.get('isSysProxyEnabled'));
    paintState('dz-tun-sub', !!appStore.get('isTunEnabled'));
    _cleanups.push(appStore.subscribe('isSysProxyEnabled', (/** @type {boolean} */ v) => paintState('dz-sys-sub', !!v)));
    _cleanups.push(appStore.subscribe('isTunEnabled', (/** @type {boolean} */ v) => paintState('dz-tun-sub', !!v)));

    // ── Lower-latency nodes in the node card ──
    const altsList = $('dz-node-alts-list');
    if (altsList) on(altsList, 'click', (/** @type {Event} */ e) => {
        const btn = /** @type {HTMLElement | null} */ ((/** @type {HTMLElement} */ (e.target)).closest?.('.dz-alt'));
        const idx = btn ? pickerNodes.findIndex((n) => n.name === btn.dataset.node) : -1;
        if (idx >= 0) void selectPickerNode(idx, btn?.dataset.group || '');
    });

    // ── Profile menu in the subscription card ──
    _cleanups.push(initHomeProfile({ hostId: 'dz-profile', btnId: 'dz-profile-btn' }));
    // Only the address line redraws (the node's other controls keep focus),
    // and only while the console shows: the minimal home has its own.
    const shownLeaf = () => $('dz-node-name')?.dataset.leaf || '';
    _cleanups.push(Bus.on(Events.EXIT_IP_SETTING_CHANGED, () => {
        closeNodeDetails();
        // Hidden or not, the old address goes now: turned off, it must not
        // show again on the way back (a failed refresh would leave it there).
        forgetNodeIp();
        if (isActive && shownLeaf()) void renderNodeIp(shownLeaf());
    }));
    _cleanups.push(onExitIpRefreshed((leaf) => {
        if (isActive && leaf && leaf === shownLeaf()) void renderNodeIp(leaf);
    }));

    // ── Wide windows: the subscription card joins the bottom row ──
    _cleanups.push(placeSubCard());

    // ── i18n: re-render dynamic content on language change ──
    _cleanups.push(Bus.on(Events.I18N_APPLIED, () => {
        // Sort label and tooltip
        const sortLabel = $('dz-sort-label');
        if (sortLabel) sortLabel.textContent = t(SORT_MODES[sortIdx].labelKey);
        const sortBtnEl = $('dz-sort-btn');
        if (sortBtnEl) sortBtnEl.title = t('consoleSortHint');

        // Aria-labels and titles
        const pickerListI18n = $('dz-picker-list');
        if (pickerListI18n) pickerListI18n.setAttribute('aria-label', t('consoleNodePicker'));
        const hostEl = $('dz-node-host');
        if (hostEl) hostEl.title = t('consoleCopyHint');
        document.querySelectorAll('#dz-node-alts-list .dz-alt').forEach((button) => {
            const row = /** @type {HTMLElement} */ (button);
            row.title = t('homeSwitchTo', { name: row.dataset.node || '' });
        });

        // Re-render picker, subscription, and latency badge
        renderPicker();
        renderSubscriptionCard();
        // Pending too: its screen-reader label is in the old language.
        renderLatency(state.latency, latencyStatus);
        // The exit address line: its country and title, from the cached lookup.
        const ipLine = $('dz-node-ip');
        const ipLeaf = ipLine?.dataset.leaf;
        if (ipLine && ipLeaf && !ipLine.hidden) {
            void renderNodeIp(ipLeaf);
        }
    }));

    // Register all cleanups (after all _cleanups pushes are done)
    _cleanups.forEach(fn => _globalUnregs.push(registerCleanup(/** @type {() => void} */ (fn))));

    // Initial render
    renderNumbers();
    requestAnimationFrame(() => drawChart($('dz-chart')));

    // Start data refresh

    // Mark initialization as complete — must be the last step so that
    // a throw in any earlier setup step leaves isInitialized false and
    // allows a retry on the next initConsoleHome() call.
    isInitialized = true;
    consoleLogger.info('Console home page initialized');
}

/**
 * Activate the console page (called when navigating to it).
 * Starts data polling and triggers initial data fetch.
 */
export function activateConsole() {
    // Lazy-initialize the console DOM if not yet done (e.g., user switched
    // to console mode from settings after startup with minimal mode).
    // initConsoleHome() is idempotent — guarded by isInitialized.
    try {
        initConsoleHome();
    } catch (err) {
        // If initialization fails, show an error message instead of leaving
        // a permanently blank page. The user can navigate away and retry.
        consoleLogger.error('Console home initialization failed', err);
        const container = document.querySelector('[data-page="console"]');
        if (container) {
            container.replaceChildren();
            const failMsg = document.createElement('div');
            failMsg.style.cssText = 'padding:2rem;color:var(--text-secondary)';
            failMsg.textContent = t('consoleInitFail');
            container.appendChild(failMsg);
        }
        return;
    }
    isActive = true;
    if (latencyStatus === 'none' || $('dz-node-lat')?.textContent === t('homeStopped')) renderLatency(0, 'pending');
    nodeRetryCount = 0;
    prevConnStats.clear(); // reset so first poll doesn't compute bogus speed from stale snapshot
    state.sessDown = 0; // reset session traffic on new session
    state.sessUp = 0;
    lastTrafficTsMsSession = null; // reset session timestamp so first sample integrates correctly
    renderSessionTotals(); // immediately reflect reset in the DOM
    // Reload logs from buffer so the panel is fresh after navigating away and back
    const logList = $('dz-log-list');
    if (logList) logList.replaceChildren();
    loadInitialLogs();
    if (!connPollTimer) connPollTimer = setInterval(pollConnections, 2000);
    void refreshNodeData();
    void pollConnections();
    void refreshSubscriptionData();
    requestAnimationFrame(() => {
        drawChart($('dz-chart'));
    });
}

/**
 * Deactivate the console page (called when navigating away).
 */
export function deactivateConsole() {
    isActive = false;
    nodeIpAsk++;
    pendingNodeIpResume?.();
    pendingNodeIpResume = null;
    closeNodeDetails();
    if (connPollTimer) { clearInterval(connPollTimer); connPollTimer = null; }
    if (nodeRetryTimer) { clearTimeout(nodeRetryTimer); nodeRetryTimer = null; }
    nodeRetryCount = 0;
    // Each visit gets its own later exit-address try.
    if (nodeIpRetryTimer) { clearTimeout(nodeIpRetryTimer); nodeIpRetryTimer = null; }
    nodeIpRetryLeaf = '';
    pendingLatencyRetry?.();
    pendingLatencyRetry = null;
    prevConnStats.clear(); // discard stale snapshot to avoid huge fake speed on re-activate
}
