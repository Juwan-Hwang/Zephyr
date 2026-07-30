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

import { getConnections, testProxy, switchProxy, getConfig, invoke, closeAllConnections } from '../api.js';
import { appStore } from './state.js';

import { Bus, Events } from './events.js';
import { bind } from './bind.js';

import { subscribeToEvents, getExtLogEvents } from '../modules/backend-events.js';
import { registerCleanup } from '../utils/cleanup-registry.js';
import { createLogger } from '../utils/logger.js';
import { showNotification } from './notifications.js';
import { t, applyTranslations } from '../i18n.js';
import { COMMANDS } from '@zephyr/shared';
import { syncCoreConfig, resolveLeafNode } from './proxies.js';
import { switchToConfig } from './lifecycle.js';
import { fetchProxyGroups } from './proxy-groups.js';
import { saveProxySelection } from './proxy-memory.js';
import { invalidateProxiesCache, invalidateSettingsCache, invalidateConfigsCache, getSettingsCached } from './cache.js';
import { getRunConfigCached, invalidateRunConfigCache } from './run-config-cache.js';
import { getSubscriptionUserAgent } from './settings.js';
import { setSysProxyEnabled, refreshSysProxyStatus } from './sysproxy.js';

/** Map app language code to BCP-47 locale tag for Intl APIs. */
const LOCALE_TAGS = { en: 'en', zh: 'zh-CN', ja: 'ja-JP', ko: 'ko-KR' };

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

/** @param {string} name */
function cssVar(name) {
    return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
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
/** @type {ReturnType<typeof setInterval> | null} */
let uptimeTimer = null;
/** @type {ReturnType<typeof setTimeout> | null} */
let nodeRetryTimer = null;
/**
 * Core uptime in seconds, fetched from the backend (real mihomo spawn time).
 * Null until the first successful fetch.
 * @type {number | null}
 */
/** @type {number | null | undefined} undefined=not-fetched, null=core-stopped, number=running uptime in seconds. */
let coreUptimeSec;
let isInitialized = false;
let isActive = false;
/** @type {number | null} Timestamp (ms) of the last traffic sample for lifetime totals (never reset). */
let lastTrafficTsMsTotal = null;
/** @type {number | null} Timestamp (ms) of the last traffic sample for session totals (reset on activate). */
let lastTrafficTsMsSession = null;
/** @type {number} Counter for periodic uptime re-sync. */
let uptimeSyncCounter = 0;

/** @type {Function[]} */
const _cleanups = [];
/** @type {Function[]} Unregister functions for global registry entries. */
const _globalUnregs = [];

/**
 * Register an event listener and push a matching removal function into _cleanups.
 * Ensures every listener is tracked for consistent teardown on retry/destroy.
 * @param {EventTarget} el
 * @param {string} event
 * @param {EventListenerOrEventListenerObject} handler
 * @param {boolean | AddEventListenerOptions} [options]
 */
function on(el, event, handler, options) {
    el.addEventListener(event, handler, options);
    _cleanups.push(() => el.removeEventListener(event, handler, options));
}

// ── Canvas Chart (ported from draft) ─────────────────────────────────────

/**
 * @param {HTMLCanvasElement} canvas
 * @returns {{ ctx: CanvasRenderingContext2D, w: number, h: number }}
 */
function setupCanvas(canvas) {
    const dpr = window.devicePixelRatio || 1;
    const rect = canvas.getBoundingClientRect();
    canvas.width = Math.max(1, Math.round(rect.width * dpr));
    canvas.height = Math.max(1, Math.round(rect.height * dpr));
    const ctx = canvas.getContext('2d');
    if (!ctx) return { ctx: /** @type {any} */ (null), w: 0, h: 0 };
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
 * @param {string} fillTop
 */
function drawSeries(ctx, w, h, data, key, max, rgb, fillTop) {
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
    buildPath('lineTo');
    ctx.lineTo(w, h);
    ctx.lineTo(0, h);
    ctx.closePath();
    const g = ctx.createLinearGradient(0, 0, 0, h);
    g.addColorStop(0, fillTop);
    g.addColorStop(1, `rgba(${rgb},0)`);
    ctx.fillStyle = g;
    ctx.fill();

    // Stroke path: data curve only.
    buildPath('moveTo');
    ctx.strokeStyle = `rgba(${rgb},0.9)`;
    ctx.lineWidth = 1.6;
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
    // Fixed palette — does NOT follow theme accent (speed colors must be stable)
    drawSeries(ctx, w, h, trafficHistory, 'up', max, '56,189,248', 'rgba(56,189,248,0.14)');
    drawSeries(ctx, w, h, trafficHistory, 'down', max, '175,82,222', 'rgba(175,82,222,0.20)');
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

function renderUptime() {
    if (coreUptimeSec === undefined) {
        // Not yet fetched — show neutral placeholder until first successful response
        const el0 = $('dz-uptime');
        if (el0) el0.textContent = '—';
        return;
    }
    if (coreUptimeSec === null) {
        // Core is not running
        const el0 = $('dz-uptime');
        if (el0) el0.textContent = t('consoleUptimeStopped');
        return;
    }
    const s = coreUptimeSec;
    const days = Math.floor(s / 86400);
    const hh = String(Math.floor((s % 86400) / 3600)).padStart(2, '0');
    const mm = String(Math.floor((s % 3600) / 60)).padStart(2, '0');
    const ss = String(s % 60).padStart(2, '0');
    const el = $('dz-uptime');
    if (el) el.textContent = t('consoleUptimeFmt', { days: String(days), time: `${hh}:${mm}:${ss}` });
}

/** Advance the local uptime counter by one second and re-render. */
function tickUptime() {
    // Re-sync with backend every 30 ticks to detect core stop/crash.
    // This runs even when coreUptimeSec is null so we can detect recovery.
    if (++uptimeSyncCounter >= 30) {
        uptimeSyncCounter = 0;
        fetchCoreUptime();
    }
    if (coreUptimeSec === null || coreUptimeSec === undefined) return;
    coreUptimeSec++;
    renderUptime();
}

function renderLatency(/** @type {number} */ v) {
    state.latency = v;
    const latEl = $('dz-lat-val');
    if (latEl) latEl.textContent = v > 0 ? String(v) : '—';
    const nodeLat = $('dz-node-lat');
    if (nodeLat) nodeLat.textContent = v > 0 ? String(v) : '—';
    if (v <= 0) {
        // Clear badges on failure so stale class/text don't persist
        for (const id of ['dz-lat-badge', 'dz-node-lat-badge']) {
            const b = $(id);
            if (b) { b.className = 'latency-badge'; b.textContent = '—'; }
        }
        return;
    }
    const [cls, txt] = latBadge(v);
    for (const id of ['dz-lat-badge', 'dz-node-lat-badge']) {
        const b = $(id);
        if (b) {
            b.className = 'latency-badge ' + cls;
            b.textContent = txt;
        }
    }
}

// ── Connections ──────────────────────────────────────────────────────────

/**
 * @typedef {{ proc: string, host: string, chain: string, tcp: boolean, speed: number, total: number, color: string }} ConnRow
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
        const proc = md.process || md.processPath || t('unknown');
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
            host: host,
            chain: chain,
            tcp: (md.network || 'tcp').toLowerCase() === 'tcp',
            speed: speed,
            total: (upload + download) / 1024 / 1024, // MB
            color: procColor(proc),
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

/** Generate a stable color from a process name. @param {string} name */
function procColor(name) {
    let hash = 0;
    for (let i = 0; i < name.length; i++) hash = name.charCodeAt(i) + ((hash << 5) - hash);
    const hue = Math.abs(hash) % 360;
    return `hsl(${hue}, 65%, 55%)`;
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
        const procEl = document.createElement('span');
        procEl.className = 'dz-conn-proc';
        procEl.style.background = c.color;
        procEl.textContent = c.proc.slice(0, 1).toUpperCase();
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

async function pollConnections() {
    if (!isActive || _pollInFlight) return;
    _pollInFlight = true;
    try {
        const data = await getConnections();
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
        const currentConfig = settings?.last_config || '';
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
 * @returns {Promise<{ currentNodeName: string, proxyMap: Record<string, any>, hostMap: Record<string, {server?: string, port?: number|string}> }>}
 */
async function buildPickerFromProxyGroups(proxyGroupsResult) {
    const proxyMap = /** @type {Record<string, any>} */ (/** @type {any} */ (proxyGroupsResult.data)?.proxies || {});
    let currentNodeName = proxyGroupsResult.current || '';
    const uiGroupName = proxyGroupsResult.uiGroupName || proxyGroupsResult.mainGroup || '';
    if (uiGroupName && proxyMap[uiGroupName]) {
        currentNodeName = proxyMap[uiGroupName].now || currentNodeName;
    }
    // Persist the resolved group so the picker click handler can use it
    // even when the user has not visited the Proxies page yet.
    if (uiGroupName) appStore.set('uiGroupName', uiGroupName);

    // Fetch subscription configs for picker tabs
    subConfigs = await loadSubConfigs();

    // Build host map from run_config.yaml
    const runConfig = await getRunConfigCached();
    const hostMap = buildHostMap(runConfig);

    // Build the flat node list for the picker
    const activeGroupAll = proxyMap[uiGroupName]?.all || [];
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

        // 2. Fetch proxy data for latency + picker
        const preferredGroupName = appStore.get('uiGroupName') || null;
        const proxyGroupsResult = await fetchProxyGroups({ preferredGroupName });
        const configData = await getConfig();

        // Update version info
        const ver = /** @type {any} */ (configData)?.version;
        if (ver) {
            const verEl = $('dz-version');
            if (verEl) verEl.textContent = 'mihomo ' + ver;
        }

        if (!proxyGroupsResult) {
            scheduleNodeRetry();
            return;
        }

        const { currentNodeName, proxyMap, hostMap } = await buildPickerFromProxyGroups(proxyGroupsResult);

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
        return; // exhausted retries — give up silently
    }
    const delay = NODE_RETRY_DELAYS[nodeRetryCount++];
    nodeRetryTimer = setTimeout(() => {
        nodeRetryTimer = null;
        refreshNodeData();
    }, delay);
}

// resolveLeafNode is imported from proxies.js to avoid duplication.

/**
 * @param {string} nodeName
 * @param {Record<string, any>} proxies
 * @param {Record<string, {server?: string, port?: number|string}>} [hostMap]
 */
function renderNodeCard(nodeName, proxies, hostMap = {}) {
    // Resolve to leaf node (nodeName may be a group like "♻️ 自动选择")
    const leafName = resolveLeafNode(nodeName, proxies) || nodeName;
    const node = proxies[leafName] || proxies[nodeName];
    const host = hostMap[leafName] || hostMap[nodeName];
    const nameEl = $('dz-node-name');
    const hostEl = $('dz-node-host');
    const typeEl = $('dz-node-type');
    if (nameEl) {
        nameEl.textContent = (leafName && leafName !== nodeName) ? `${nodeName} - ${leafName}` : (leafName || nodeName || '—');
        nameEl.dataset.leaf = leafName || nodeName || '';
    }
    if (hostEl) hostEl.textContent = host?.server ? `${host.server}:${host.port || ''}` : '';
    if (typeEl) typeEl.textContent = node?.type || '—';

    // dz-node-host already shows server:port — no separate exit-IP row (mihomo doesn't expose real exit IP)

    // Extract latency from proxy history (mihomo /proxies → history[].delay)
    const history = node?.history;
    const lastDelay = (history && history.length > 0) ? history[history.length - 1].delay : 0;
    renderLatency(lastDelay || 0);

    // Render node picker
    renderPicker();
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
    if (pickerNodes.length === 0) return;

    // Set up delegated event listeners once on the container
    if (!listEl.dataset.delegated) {
    on(listEl, 'click', (/** @type {Event} */ ev) => {
            const target = /** @type {HTMLElement|null} */ (ev.target);
            const row = /** @type {HTMLElement|null} */ (target ? target.closest('.dz-picker-node') : null);
            if (row && listEl.contains(row)) {
                const idx = Number(row.dataset.idx);
                if (Number.isInteger(idx)) selectPickerNode(idx);
            }
        });
            on(listEl, 'keydown', (/** @type {KeyboardEvent} */ ev) => {
            const target = /** @type {HTMLElement|null} */ (ev.target);
            const row = /** @type {HTMLElement|null} */ (target ? target.closest('.dz-picker-node') : null);
            if (row && listEl.contains(row) && (ev.key === 'Enter' || ev.key === ' ')) {
                ev.preventDefault();
                const idx = Number(row.dataset.idx);
                if (Number.isInteger(idx)) selectPickerNode(idx);
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
 */
async function selectPickerNode(i) {
    const n = pickerNodes[i];
    if (!n) return;
    if (i === activeNodeIdx) {
        setPicker(false);
        return;
    }
    try {
        const targetGroup = appStore.get('uiGroupName') || '';
        if (!targetGroup) {
            consoleLogger.warn('No proxy group selected, cannot switch node');
            showNotification(t('notifSwitchFailed'), 'error');
            return;
        }
        const success = await switchProxy(targetGroup, n.name);
        if (!success) {
            showNotification(t('notifSwitchFailed'), 'error');
            return;
        }
        // Switch succeeded — post-switch steps are non-critical.
        activeNodeIdx = i;
        invalidateProxiesCache();
        try {
            await closeAllConnections();
        } catch (e) {
            consoleLogger.warn('Failed to close connections after node switch', e);
        }
        try {
            const settings = await getSettingsCached();
            const profileName = settings?.last_config;
            if (profileName) {
                await saveProxySelection(profileName, { node: n.name, group: targetGroup });
            }
        } catch (e) { consoleLogger.warn('Failed to save proxy selection', e); }
        Bus.emit(Events.PROXY_SELECTED, { node: n.name, group: targetGroup });
        try {
            await syncCoreConfig();
        } catch (e) {
            consoleLogger.warn('Failed to sync core config after node switch', e);
        }
    } catch (e) {
        consoleLogger.warn('Failed to switch node', e);
        showNotification(t('notifSwitchFailed'), 'error');
    }
    renderPicker();
    setPicker(false);
}

// ── Picker open/close ────────────────────────────────────────────────────

/** @param {boolean} open */
function setPicker(open) {
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

async function refreshSubscriptionData() {
    if (!isActive) return;
    try {
        const settings = await getSettingsCached();
        const currentConfig = settings?.last_config || '';
        const configs = await invoke(COMMANDS.LIST_CONFIGS);
        const subscriptionConfigs = (configs || []).filter((/** @type {any} */ c) => c.url_display);
        // Show the currently active subscription, not just the first one
        _subConfig = subscriptionConfigs.find((/** @type {any} */ c) => c.name === currentConfig)
            || subscriptionConfigs[0]
            || null;
        renderSubscriptionCard();
    } catch (e) {
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
 * Parse subscription info string into { upload, download, total, expire }.
 * @param {string | undefined} subInfo
 * @returns {{ upload: number, download: number, total: number, expire: number }}
 */
function parseSubInfo(subInfo) {
    if (!subInfo) return { upload: 0, download: 0, total: 0, expire: 0 };
    let upload = 0, download = 0, total = 0, expire = 0;
    for (const p of subInfo.split(';')) {
        const s = p.trim();
        if (s.startsWith('upload=')) upload = Number.parseInt(s.slice(7), 10) || 0;
        else if (s.startsWith('download=')) download = Number.parseInt(s.slice(9), 10) || 0;
        else if (s.startsWith('total=')) total = Number.parseInt(s.slice(6), 10) || 0;
        else if (s.startsWith('expire=')) expire = Number.parseInt(s.slice(7), 10) || 0;
    }
    return { upload, download, total, expire };
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
        if (usedValEl) usedValEl.textContent = (used / 1073741824).toFixed(1);
        if (usedLabelEl) usedLabelEl.textContent = '/ ' + (total / 1073741824).toFixed(0) + ' GB ' + t('consoleSubUsed');
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
        const diffDays = Math.floor((expireTs - Date.now() / 1000) / 86400);
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

    if (updateBtn) updateBtn.disabled = false;
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
    try {
        const results = await invoke(COMMANDS.DOWNLOAD_SUB_BATCH, {
            items: [{ name: _subConfig.name }],
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
            if (cfgSettings?.last_config === _subConfig.name) {
                await switchToConfig(_subConfig.name, cfgSettings?.custom_args || []);
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
        seg.querySelectorAll('button').forEach((/** @type {HTMLButtonElement} */ b, /** @type {number} */ j) => b.classList.toggle('active', j === idx));
        if (slider) slider.style.transform = `translateX(${idx * 100}%)`;
    }
}

// ── HTML Template ────────────────────────────────────────────────────────

const TEMPLATE = `
<div class="dz-content custom-scrollbar">
    <header class="dz-header">
        <div>
            <h1 id="dz-page-title" data-i18n="consoleTitle">Console</h1>
            <div class="dz-sub">
                <span class="dz-live-dot"></span>
                <span id="dz-uptime" data-i18n="consoleUptimeRunning">Core running —</span>
                <span style="color:var(--zephyr-text-tertiary)">·</span>
                <span id="dz-version" style="font-family:var(--font-mono)">mihomo</span>
            </div>
        </div>
    </header>

    <!-- KPI strip -->
    <div class="dz-kpis">
        <div class="glass-card dz-kpi">
            <div class="dz-kpi-top">
                <span class="dz-kpi-label" data-i18n="consoleDownSpeed">Download Speed</span>
                <span class="dz-kpi-icon" style="background:rgba(175,82,222,.12);color:#af52de;">
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3v12m0 0 5-5m-5 5-5-5"/><path d="M4 21h16"/></svg>
                </span>
            </div>
            <div class="dz-kpi-value"><b id="dz-down-val">0</b><span id="dz-down-unit">KB/s</span></div>
            <div class="dz-kpi-foot"><span data-i18n="consolePeak">Peak</span> <span id="dz-down-peak">0 KB/s</span></div>
            <canvas class="dz-spark" id="dz-spark-down"></canvas>
        </div>
        <div class="glass-card dz-kpi">
            <div class="dz-kpi-top">
                <span class="dz-kpi-label" data-i18n="consoleUpSpeed">Upload Speed</span>
                <span class="dz-kpi-icon" style="background:rgba(56,189,248,.12);color:#38bdf8;">
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 21V9m0 0 5 5m-5-5-5 5"/><path d="M4 3h16"/></svg>
                </span>
            </div>
            <div class="dz-kpi-value"><b id="dz-up-val">0</b><span id="dz-up-unit">KB/s</span></div>
            <div class="dz-kpi-foot"><span data-i18n="consolePeak">Peak</span> <span id="dz-up-peak">0 KB/s</span></div>
            <canvas class="dz-spark" id="dz-spark-up"></canvas>
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
        <div class="glass-card dz-kpi">
            <div class="dz-kpi-top">
                <span class="dz-kpi-label" data-i18n="consoleActiveConn">Active Connections</span>
                <span class="dz-kpi-icon" style="background:rgba(245,158,11,.12);color:var(--zephyr-color-warning);">
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><circle cx="5" cy="12" r="2.5"/><circle cx="19" cy="12" r="2.5"/><path d="M7.5 12h9"/></svg>
                </span>
            </div>
            <div class="dz-kpi-value"><b id="dz-conn-val">0</b><span data-i18n="consoleConnUnit">conn</span></div>
            <div class="dz-kpi-foot">TCP <span id="dz-conn-tcp">0</span> · UDP <span id="dz-conn-udp">0</span></div>
        </div>
        <div class="glass-card dz-kpi">
            <div class="dz-kpi-top">
                <span class="dz-kpi-label" data-i18n="consoleNodeLatency">Node Latency</span>
                <span class="dz-kpi-icon" style="background:rgba(175,82,222,.12);color:#af52de;">
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M13 2 3 14h7l-1 8 10-12h-7l1-8z"/></svg>
                </span>
            </div>
            <div class="dz-kpi-value"><b id="dz-lat-val">—</b><span>ms</span></div>
            <div class="dz-kpi-foot"><span class="latency-badge latency-badge--fast" id="dz-lat-badge">—</span></div>
        </div>
    </div>

    <!-- Main grid: chart + sidebar -->
    <div class="dz-grid-main">
        <div class="glass-card dz-card-pad" style="display:flex;flex-direction:column;">
            <div class="dz-card-head">
                <div class="dz-card-title"><span class="dot"></span><span data-i18n="consoleRealtimeTraffic">Real-time Traffic</span></div>
                <div class="dz-legend">
                    <div class="dz-legend-item"><span class="dz-legend-swatch" style="background:rgba(175,82,222,.8)"></span><span data-i18n="consoleDownload">Download</span></div>
                    <div class="dz-legend-item"><span class="dz-legend-swatch" style="background:rgba(56,189,248,.8)"></span><span data-i18n="consoleUpload">Upload</span></div>
                </div>
            </div>
            <div class="dz-chart-wrap"><canvas id="dz-chart"></canvas></div>
            <div class="dz-chart-meta">
                <div><span data-i18n="consoleAvgMin">1 min avg</span><b id="dz-avg-down">0 KB/s ↓</b></div>
                <div><span data-i18n="consoleSessionDown">Session DL</span><b id="dz-sess-down">0 B</b></div>
                <div><span data-i18n="consoleSessionUp">Session UL</span><b id="dz-sess-up">0 B</b></div>
                <div><span data-i18n="consoleSampleInterval">Sample interval</span><b data-i18n="consoleSampleValue">1s · 60pt window</b></div>
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
                    <div class="dz-node-latency">
                        <span class="dz-latency-num"><span id="dz-node-lat">—</span><small>ms</small></span>
                        <span class="latency-badge latency-badge--fast" id="dz-node-lat-badge">—</span>
                        <button class="btn-ghost dz-test-btn" id="dz-test-btn" style="padding:5px 12px;font-size:11px;">
                            <svg class="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" style="width:12px;height:12px;"><path d="M21 12a9 9 0 1 1-9-9c2.52 0 4.93 1 6.74 2.74L21 8"/><path d="M21 3v5h-5"/></svg>
                            <span data-i18n="consoleTestLatency">Test</span>
                        </button>
                    </div>
                </div>
                <div class="dz-node-picker dz-hidden" id="dz-node-picker">
                    <div class="dz-picker-subs" id="dz-picker-subs"></div>
                    <div class="dz-picker-list custom-scrollbar" id="dz-picker-list" role="listbox" aria-label="Node picker"></div>
                </div>
            </div>

            <div class="glass-card dz-card-pad" style="flex:1;">
                <div class="dz-card-head" style="margin-bottom:0;">
                    <div class="dz-card-title"><span class="dot"></span><span data-i18n="consoleQuickControl">Quick Controls</span></div>
                </div>
                <div class="dz-mode-seg" id="dz-mode-seg">
                    <div class="dz-mode-slider" id="dz-mode-slider"></div>
                    <button type="button" data-mode="rule" data-i18n="rule">Rule</button>
                    <button type="button" data-mode="global" data-i18n="global">Global</button>
                    <button type="button" data-mode="direct" data-i18n="direct">Direct</button>
                </div>
                <div class="dz-quick-rows">
                    <div class="dz-quick-row">
                        <span class="dz-quick-row-label">
                            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/></svg>
                            <span id="dz-sys-toggle-label" data-i18n="consoleSysProxy">System Proxy</span>
                        </span>
                        <label class="ios-switch switch-lg"><input type="checkbox" id="dz-sys-toggle" aria-labelledby="dz-sys-toggle-label"><span class="switch-slider"></span></label>
                    </div>
                    <div class="dz-quick-row">
                        <span class="dz-quick-row-label">
                            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="2" y="3" width="20" height="14" rx="2" ry="2"/><line x1="8" y1="21" x2="16" y2="21"/><line x1="12" y1="17" x2="12" y2="21"/></svg>
                            <span id="dz-tun-toggle-label" data-i18n="consoleTunAdapter">TUN Adapter</span>
                        </span>
                        <label class="ios-switch switch-lg"><input type="checkbox" id="dz-tun-toggle" aria-labelledby="dz-tun-toggle-label"><span class="switch-slider"></span></label>
                    </div>
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

        <div class="glass-card dz-card-pad" style="display:flex;flex-direction:column;overflow:visible;">
            <div class="dz-card-head">
                <div class="dz-card-title"><span class="dot"></span><span data-i18n="consoleSubUsage">Subscription</span></div>
            </div>
            <div style="font-size:13px;font-weight:600;color:var(--zephyr-text-primary);" id="dz-sub-name">—</div>
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
    sortBtn?.title = t('consoleSortHint');
    if (sortBtn) on(sortBtn, 'click', () => {
        sortIdx = (sortIdx + 1) % SORT_MODES.length;
        const label = $('dz-sort-label');
        if (label) label.textContent = t(SORT_MODES[sortIdx].labelKey);
        pollConnections();
    });

    // ── Node picker ──
    const pickerBtn = $('dz-node-picker-btn');
    if (pickerBtn) on(pickerBtn, 'click', (e) => {
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
        const copyHost = () => {
            const text = hostCopyEl.textContent || '';
            if (!text) return;
            const done = () => {
                const orig = hostCopyEl.style.color;
                hostCopyEl.style.color = 'var(--zephyr-color-success)';
                setTimeout(() => { hostCopyEl.style.color = orig; }, 1200);
            };
            const failed = (/** @type {unknown} */ err) => {
                consoleLogger.warn('Failed to copy node host', err);
                const orig = hostCopyEl.style.color;
                hostCopyEl.style.color = 'var(--zephyr-color-danger)';
                setTimeout(() => { hostCopyEl.style.color = orig; }, 1200);
            };
            if (navigator.clipboard?.writeText) {
                navigator.clipboard.writeText(text).then(done).catch(failed);
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
    const testBtn = /** @type {HTMLButtonElement | null} */ ($('dz-test-btn'));
        if (testBtn) on(testBtn, 'click', async () => {
        const btn = testBtn;
        const leafName = $('dz-node-name')?.dataset.leaf;
        if (!leafName) return;
        btn.setAttribute('aria-busy', 'true');
        btn.disabled = true;
        try {
            const delay = await testProxy(leafName, 5000);
            renderLatency(delay);
        } catch {
            renderLatency(-1);
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
    _cleanups.push(bind(appStore, tunToggle, 'isTunEnabled', 'checked'));
    on(tunToggle, 'change', () => {
            const enabled = tunToggle.checked;
            const mainToggle = /** @type {HTMLInputElement | null} */ (document.getElementById('tun-proxy-toggle'));
            if (mainToggle) {
                mainToggle.checked = enabled;
                // Dispatch a real change event so both onchange handlers and
                // addEventListener('change', ...) listeners in tun.js fire.
                // The handler in initTunToggle will update appStore on success
                // or roll back on failure, keeping state in sync.
                mainToggle.dispatchEvent(new Event('change', { bubbles: true }));
            } else {
                // Fallback: no main toggle, update appStore directly
                appStore.set('isTunEnabled', enabled);
            }
        });
    }

    // Update proxy/TUN status text

    // ── Mode selector sync ──
    _cleanups.push(appStore.subscribe('currentOutboundMode', (/** @type {string} */ mode) => syncModeSegs(mode)));
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
        if (lastTrafficTsMsTotal) {
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
        drawChart($('dz-chart'));
        drawSpark($('dz-spark-down'), 'down', '175,82,222');
        drawSpark($('dz-spark-up'), 'up', '56,189,248');
    }));

    // ── Log stream ──
    loadInitialLogs();
    const _logCb = (/** @type {{ type: string, message: string, timestamp: string, source?: string }} */ entry) => { if (isActive) pushLog(entry); };
    const _unsubLog = subscribeToEvents(_logCb);
    _cleanups.push(_unsubLog);

    // ── Proxy events ──
    _cleanups.push(Bus.on(Events.PROXY_SELECTED, () => {
        refreshNodeData();
    }));

    // ── Core restart: reset traffic counters ──
    // CORE_RESTARTED fires when mihomo just started. We reset counters here
    // (not on CONFIG_UPDATED) because CONFIG_UPDATED also fires on non-restart
    // settings changes (restore defaults, node-scroll toggle, etc.).
    const _coreRestartedUnsub = Bus.on(Events.CORE_RESTARTED, () => {
        state.totalDown = 0;
        state.totalUp = 0;
        state.downPeak = 0;
        state.upPeak = 0;
        state.sessDown = 0;
        state.sessUp = 0;
        trafficHistory.length = 0;
        lastTrafficTsMsTotal = null;
        lastTrafficTsMsSession = null;
    });
    _cleanups.push(() => _coreRestartedUnsub());

    // ── Config update: refresh all console data ──
    // Listen to CONFIG_UPDATED (emitted after full postRestartRecovery:
    // overrides applied, proxy selection restored, caches invalidated).
    // Also fires on non-restart settings changes — that's fine for data refresh.
    const _configUpdatedUnsub = Bus.on(Events.CONFIG_UPDATED, () => {
        if (!isActive) return; // skip IPC calls when console page is hidden
        nodeRetryCount = 0; // core fully restarted - give retry budget back
        fetchCoreUptime(); // uptime resets after restart
        refreshNodeData({ forceInvalidate: true });
        refreshSubscriptionData();
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

    // ── Uptime ── Fetch real uptime from backend, then tick locally every second.
    // NOTE: fetchCoreUptime() is called from activateConsole(), not here,
    // to avoid showing a transient "core stopped" state during early init
    // when the core hasn't started yet.
    _cleanups.push(() => { if (uptimeTimer) { clearInterval(uptimeTimer); uptimeTimer = null; } });

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
        const btn = subUpdateBtn;
        setSubUpdateBtnState(btn, true);
        btn.disabled = true;
        try {
            await updateSubscription();
        } finally {
            setSubUpdateBtnState(btn, false);
            btn.disabled = false;
            refreshSubscriptionData();
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

        // Re-render uptime, picker, subscription, and latency badge
        renderUptime();
        renderPicker();
        renderSubscriptionCard();
        if (state.latency > 0) renderLatency(state.latency);
    }));

    // Register all cleanups (after all _cleanups pushes are done)
    _cleanups.forEach(fn => _globalUnregs.push(registerCleanup(/** @type {() => void} */ (fn))));

    // Initial render
    renderNumbers();
    renderUptime();
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
    nodeRetryCount = 0;
    uptimeSyncCounter = 0; // prevent immediate re-fetch duplicate
    prevConnStats.clear(); // reset so first poll doesn't compute bogus speed from stale snapshot
    state.sessDown = 0; // reset session traffic on new session
    state.sessUp = 0;
    lastTrafficTsMsSession = null; // reset session timestamp so first sample integrates correctly
    renderSessionTotals(); // immediately reflect reset in the DOM
    // Reload logs from buffer so the panel is fresh after navigating away and back
    const logList = $('dz-log-list');
    if (logList) logList.replaceChildren();
    loadInitialLogs();
    if (!uptimeTimer) uptimeTimer = setInterval(tickUptime, 1000);
    if (!connPollTimer) connPollTimer = setInterval(pollConnections, 2000);
    fetchCoreUptime(); // re-sync real uptime from backend
    refreshNodeData();
    pollConnections();
    refreshSubscriptionData();
    requestAnimationFrame(() => {
        drawChart($('dz-chart'));
    });
}

/**
 * Deactivate the console page (called when navigating away).
 */
export function deactivateConsole() {
    isActive = false;
    if (uptimeTimer) { clearInterval(uptimeTimer); uptimeTimer = null; }
    if (connPollTimer) { clearInterval(connPollTimer); connPollTimer = null; }
    if (nodeRetryTimer) { clearTimeout(nodeRetryTimer); nodeRetryTimer = null; }
    nodeRetryCount = 0;
    prevConnStats.clear(); // discard stale snapshot to avoid huge fake speed on re-activate
}

/**
 * Fetch the real mihomo uptime (seconds since spawn) from the Rust backend.
 * The backend records Instant::now() when the process is spawned and
 * returns the elapsed duration.  We then increment locally every second
 * via renderUptime() to avoid continuous IPC polling.
 */
async function fetchCoreUptime() {
    try {
        const uptime = await invoke(COMMANDS.GET_CORE_UPTIME);
        // undefined=not-fetched, null=core-stopped, number=running
        coreUptimeSec = typeof uptime === 'number' ? uptime : null;
        renderUptime();
    } catch (e) {
        // Log the failure but do NOT reset coreUptimeSec — keep displaying
        // the last known uptime while we retry fetching. If the core truly stopped,
        // the next successful fetch will return null and we'll reset then.
        consoleLogger.warn('Failed to fetch core uptime', e);
        renderUptime();
    }
}
