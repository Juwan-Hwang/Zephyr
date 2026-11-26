// @ts-check
/**
 * Download speed test (modelled on v2rayN's speed test).
 *
 * - "Test Download Speed" in the proxies header tests every node of the group
 *   shown; the download button on a node card tests that node alone.
 * - Each run first tests latency; timed-out nodes are skipped. Then one node at
 *   a time (never in parallel: parallel downloads share the bandwidth and the
 *   numbers stop being comparable) downloads the test file through the hidden
 *   speed-test listener for at most the configured seconds.
 * - The result is the best one-second speed, in MB/s with one decimal, shown
 *   in place of the card's protocol line. "By Download Speed" sorts by it.
 * - While running the header button reads "Stop Test 3/12"; Esc also stops.
 *
 * The backend (src-tauri/src/speed_test.rs) owns the download; this module owns
 * the queue, the results and the settings that pick the file and time limit.
 *
 * @module ui/speed-test
 */

import {
    testProxy, getProxyRecord, getLatencyTestUrl, abortLatencyTests, speedTestPort, speedTestGeneration, selectSpeedTestNode, speedTestDownload, speedTestCancel, listen,
} from '../api.js';
import { isRealOutboundNode } from './proxy-groups.js';
import { getSettingsCached } from './cache.js';
import { saveSettingsChecked } from './settings-helpers.js';
import { proxyLogger } from '../utils/logger.js';
import { Bus, Events } from './events.js';

/** Event the backend sends while a download runs. */
export const PROGRESS_EVENT = 'speed-test-progress';

/** Seconds a node may download for. */
export const SPEED_TEST_SECS = /** @type {const} */ ([10, 20, 30]);
export const DEFAULT_SPEED_TEST_SECS = 10;

/**
 * Test files. `bytes` is the file size, used to say how much traffic a run
 * may use; a custom address has no known size.
 * @type {ReadonlyArray<{ id: string, label: string, host: string, url: string, bytes: number }>}
 */
export const SPEED_TEST_FILES = Object.freeze([
    { id: 'cachefly-50', label: 'CacheFly 50 MB', host: 'cachefly.cachefly.net', url: 'https://cachefly.cachefly.net/50mb.test', bytes: 50 * 1024 * 1024 },
    { id: 'cachefly-10', label: 'CacheFly 10 MB', host: 'cachefly.cachefly.net', url: 'https://cachefly.cachefly.net/10mb.test', bytes: 10 * 1024 * 1024 },
    { id: 'cloudflare-10', label: 'Cloudflare 10 MB', host: 'speed.cloudflare.com', url: 'https://speed.cloudflare.com/__down?bytes=10000000', bytes: 10_000_000 },
]);
/** Same default file as v2rayN. */
export const DEFAULT_SPEED_TEST_URL = SPEED_TEST_FILES[0].url;

/** Latency pre-check timeout (ms) and how many nodes it tests at once. */
const PRECHECK_TIMEOUT = 5000;
const PRECHECK_CONCURRENCY = 6;

/**
 * @typedef {'waiting' | 'testing' | 'done' | 'skipped' | 'failed'} SpeedState
 * @typedef {{ state: SpeedState, mbps?: number, bps?: number, startedAt?: number }} SpeedEntry
 */

/** @type {Map<string, SpeedEntry>} Results of this session, by node name. */
const results = new Map();
/** @type {Set<() => void>} */
const listeners = new Set();
/**
 * @typedef {{ id: string, total: number, done: number, cancelled: boolean, maxSecs: number, wake: () => void,
 *   abort: AbortController, prev: Map<string, SpeedEntry> }} Run
 */
/** @type {Run | null} */
let run = null;
let runSeq = 0;
/** Set when the core restarted during a run: forget the results once it ends. */
let clearWhenDone = false;
/** Tail of the queue of steps that point the hidden group at a node and use it. */
let groupQueue = Promise.resolve();

/**
 * Run `fn` while nothing else re-points the hidden speed-test group: the
 * download test and the exit-address lookup both select a node in it, so each
 * select-and-request step waits for the one before it.
 * @template T
 * @param {() => Promise<T>} fn
 * @returns {Promise<T>}
 */
export function withSpeedTestGroup(fn) {
    const p = groupQueue.then(fn, fn);
    groupQueue = p.then(() => {}, () => {});
    return p;
}

function emit() {
    for (const fn of listeners) {
        try { fn(); } catch (err) { proxyLogger.warn('[speed-test] listener failed', err); }
    }
}

/**
 * Called whenever a result, the running state or the progress changes.
 * @param {() => void} fn
 * @returns {() => void} unsubscribe
 */
export function onSpeedTestChange(fn) {
    listeners.add(fn);
    return () => listeners.delete(fn);
}

/** @param {string} name @returns {SpeedEntry | undefined} */
export function speedOf(name) {
    return results.get(name);
}

/** @returns {boolean} */
export function isSpeedTestRunning() {
    return run !== null;
}

/** @returns {{ done: number, total: number } | null} */
export function speedTestProgress() {
    return run ? { done: run.done, total: run.total } : null;
}

/**
 * Share of the time limit used by the node under test, 0..1.
 * @param {string} name
 * @returns {number}
 */
export function speedTestFraction(name) {
    const e = results.get(name);
    if (!run || e?.state !== 'testing' || !e.startedAt) return 0;
    // Monotonic clock, clamped: a wall-clock change must not paint a negative bar.
    return Math.max(0, Math.min(1, (performance.now() - e.startedAt) / (run.maxSecs * 1000)));
}

/** Forget every result (a different profile has different nodes). */
export function clearSpeedResults() {
    if (run) return;
    results.clear();
    emit();
}

// The core restarted (another profile, an updated subscription): the names may
// now be other nodes. A run in progress stops and its results go when it ends.
function forgetForNewConfig() {
    if (run) {
        clearWhenDone = true;
        void stopSpeedTest();
    } else {
        clearSpeedResults();
    }
}
Bus.on(Events.CORE_RESTARTED, forgetForNewConfig);
Bus.on(Events.DIAGNOSTICS_INVALIDATED, forgetForNewConfig);
// A reload without a restart can re-point a node under the same name (an override).
Bus.on(Events.CONFIG_UPDATED, (/** @type {any} */ data) => { if (data?.reloaded) forgetForNewConfig(); });

/** Bytes per second -> MB/s (MiB, as v2rayN shows), one decimal. */
export function toMbps(/** @type {number} */ bps) {
    return Math.round((bps / (1024 * 1024)) * 10) / 10;
}

/**
 * Sort node names fastest first; skipped, failed and untested nodes keep their
 * order after the tested ones.
 * @param {string[]} names
 * @returns {string[]} the same array, sorted
 */
export function sortBySpeed(names) {
    const rank = (/** @type {string} */ n) => {
        const e = results.get(n);
        // The measured rate, not the rounded one shown: 12.34 beats 12.31.
        if (e?.state !== 'done') return -1;
        return typeof e.bps === 'number' ? e.bps : typeof e.mbps === 'number' ? e.mbps * 1024 * 1024 : -1;
    };
    const order = new Map(names.map((n, i) => [n, i]));
    return names.sort((a, b) => (rank(b) - rank(a)) || ((order.get(a) ?? 0) - (order.get(b) ?? 0)));
}

/**
 * The saved file address and time limit.
 * @returns {Promise<{ url: string, maxSecs: number, file: typeof SPEED_TEST_FILES[number] | null }>}
 */
export async function readSpeedTestSettings() {
    return speedTestSettingsOf(await getSettingsCached());
}

/**
 * The file address and time limit in already-read settings.
 * @param {any} s
 * @returns {{ url: string, maxSecs: number, file: typeof SPEED_TEST_FILES[number] | null }}
 */
export function speedTestSettingsOf(s) {
    const saved = typeof s?.speed_test_url === 'string' ? s.speed_test_url.trim() : '';
    const url = saved || DEFAULT_SPEED_TEST_URL;
    const secs = Number(s?.speed_test_max_secs);
    const maxSecs = SPEED_TEST_SECS.includes(/** @type {any} */ (secs)) ? secs : DEFAULT_SPEED_TEST_SECS;
    return { url, maxSecs, file: SPEED_TEST_FILES.find((f) => f.url === url) ?? null };
}

/**
 * Save the file address (empty: the default) and the time limit.
 * @param {{ url?: string | null, maxSecs?: number }} patch
 * @param {() => boolean} [shouldSave] checked in the settings write queue
 */
export function saveSpeedTestSettings(patch, shouldSave) {
    /** @type {Record<string, unknown>} */
    const out = {};
    if ('url' in patch) {
        const u = (patch.url || '').trim();
        out.speed_test_url = !u || u === DEFAULT_SPEED_TEST_URL ? null : u;
    }
    if (patch.maxSecs !== undefined) out.speed_test_max_secs = patch.maxSecs === DEFAULT_SPEED_TEST_SECS ? null : patch.maxSecs;
    return shouldSave ? saveSettingsChecked(out, shouldSave) : saveSettingsChecked(out);
}

/** @param {string} url */
export function isValidSpeedTestUrl(url) {
    try {
        const u = new URL(url.trim());
        return (u.protocol === 'http:' || u.protocol === 'https:') && !!u.hostname;
    } catch {
        return false;
    }
}

/** Most a download from a custom address may read (the backend's cap). */
export const CUSTOM_MAX_BYTES = 1024 ** 3;

/**
 * Most traffic a run over `count` nodes can use, in bytes: the file's size
 * each, or for a custom address (size unknown) the cap each download stops at.
 * @param {number} count
 * @param {typeof SPEED_TEST_FILES[number] | null} file
 */
export function maxTrafficBytes(count, file) {
    return count * (file ? file.bytes : CUSTOM_MAX_BYTES);
}

/**
 * Test the download speed of `names`, one after another.
 * Resolves when the run ends (finished or stopped).
 * @param {string[]} names leaf nodes, in the order to test them
 * @param {{ url: string, maxSecs: number, file: typeof SPEED_TEST_FILES[number] | null }} [confirmed]
 *   the settings a confirmation showed: the run uses exactly these
 * @returns {Promise<'done' | 'stopped' | 'unavailable' | 'busy'>}
 */
export async function startSpeedTest(names, confirmed = undefined) {
    if (run) return 'busy';
    const list = [...new Set(names)].filter(Boolean);
    if (!list.length) return 'done';
    const latencyUrl = getLatencyTestUrl();
    // Claim the run before the first await so a second start is refused.
    /** @type {() => void} */
    let wake = () => {};
    /** Resolves when Stop is pressed, so the run does not wait out requests it no longer needs. */
    const stopped = new Promise((/** @type {(v?: unknown) => void} */ r) => { wake = r; });
    /** @type {Run} */
    const me = {
        id: `run-${Date.now()}-${++runSeq}`, total: list.length, done: 0, cancelled: false,
        maxSecs: DEFAULT_SPEED_TEST_SECS, wake, abort: new AbortController(), prev: new Map(),
    };
    run = me;
    // The toolbar locks the latency test now, not only after the first await.
    emit();
    const STOP = Symbol('stop');
    /** Stop ends the run even while a setup step is still pending. */
    const orStop = (/** @type {Promise<any>} */ p) => Promise.race([p, stopped.then(() => STOP)]);
    /** @type {(() => Promise<void>) | null} */
    let unlisten = null;
    /** @type {ReturnType<typeof setInterval> | null} */
    let tick = null;
    let outcome = /** @type {'done' | 'stopped' | 'unavailable'} */ ('done');
    try {
        const nativeGeneration = await orStop(speedTestGeneration());
        if (nativeGeneration === STOP) return 'stopped';
        const port = await orStop(speedTestPort());
        if (port === STOP) {
            outcome = 'stopped';
            return outcome;
        }
        if (!port) {
            outcome = 'unavailable';
            return outcome;
        }
        const read = await orStop(confirmed ? Promise.resolve(confirmed) : readSpeedTestSettings());
        if (read === STOP || me.cancelled) {
            outcome = 'stopped';
            return outcome;
        }
        const { url, maxSecs, file } = read;
        me.maxSecs = maxSecs;
        // A previous stopped run may still be releasing its native download.
        // Keep new latency probes behind that same serialized group turn.
        if (await orStop(withSpeedTestGroup(async () => {})) === STOP || me.cancelled) return 'stopped';
        // Latency probes already in flight (a scheduled pass, the console's
        // test) would share the download's bandwidth: stop them now that the
        // run will go ahead; their callers drop an aborted result. No new one
        // starts while the run lasts.
        abortLatencyTests();
        for (const n of list) {
            // A re-test that is stopped before its turn shows the last result again.
            const old = results.get(n);
            if (old?.state === 'done' || old?.state === 'skipped' || old?.state === 'failed') me.prev.set(n, old);
            results.set(n, { state: 'waiting' });
        }
        emit();

        /** @type {Promise<(() => Promise<void>) | null>} */
        const listening = Promise.resolve().then(() => listen(PROGRESS_EVENT, (/** @type {any} */ ev) => {
            const p = ev?.payload;
            // An event still queued after this run ended belongs to no run of ours.
            if (run !== me) return;
            // A download that started just as Stop was pressed missed that cancel: stop it again.
            if (me.cancelled) { void speedTestCancel(me.id); return; }
            // Progress of an earlier run's download that has not wound down yet.
            if (p?.run && p.run !== me.id) return;
            const e = p && results.get(p.id);
            if (!e || e.state !== 'testing' || !(p.bps > 0)) return;
            e.mbps = toMbps(p.bps);
            emit();
        })).catch(() => null); // progress is optional
        const EXPIRED = Symbol('progress-listener-timeout');
        /** @type {ReturnType<typeof setTimeout> | undefined} */
        let listenTimer;
        const deadline = new Promise((resolve) => { listenTimer = setTimeout(() => resolve(EXPIRED), 3000); });
        let got;
        try { got = await orStop(Promise.race([listening, deadline])); }
        finally { clearTimeout(listenTimer); }
        if (got === STOP || got === EXPIRED) {
            // Registered after Stop or the deadline: take it off again.
            void listening.then((u) => u && Promise.resolve(u()).catch(() => { /* already gone */ }));
            if (got === STOP) {
                outcome = 'stopped';
                return outcome;
            }
        } else {
            unlisten = got;
        }
        tick = setInterval(emit, 250);

        const alive = await Promise.race([precheck(me, list, latencyUrl), stopped.then(() => /** @type {Set<string>} */ (new Set()))]);
        if (me.cancelled) return 'stopped';
        const afterPrecheck = await orStop(speedTestGeneration().catch(() => null));
        if (afterPrecheck === STOP) return 'stopped';
        if (afterPrecheck !== nativeGeneration) {
            clearWhenDone = true;
            me.cancelled = true;
            me.abort.abort();
            return 'stopped';
        }
        // Stopped while queued behind an exit-address lookup: end now, the
        // queued step sees the stop and does nothing when its turn comes.
        await Promise.race([downloadEach(me, list.filter((n) => alive.has(n)), url, maxSecs, file?.bytes ?? null, nativeGeneration), stopped]);
        if (me.cancelled) outcome = 'stopped';
        return outcome;
    } finally {
        // Nodes that never got their turn go back to what they showed before.
        for (const n of list) {
            const e = results.get(n);
            if (e?.state !== 'waiting' && e?.state !== 'testing') continue;
            const old = me.prev.get(n);
            if (old) results.set(n, old);
            else results.delete(n);
        }
        if (run === me) run = null;
        if (clearWhenDone) {
            clearWhenDone = false;
            results.clear();
        }
        if (tick) clearInterval(tick);
        if (unlisten) Promise.resolve(unlisten()).catch(() => { /* already gone */ });
        emit();
    }
}

/**
 * Latency first: timed-out nodes are skipped (as v2rayN does). Stop aborts
 * the requests in flight, so none outlives the run.
 * @param {Run} me
 * @param {string[]} list
 * @param {string} latencyUrl fixed for this run
 * @returns {Promise<Set<string>>} the nodes that answered
 */
async function precheck(me, list, latencyUrl) {
    const queue = [...list];
    /** @type {Set<string>} */
    const alive = new Set();
    const worker = async () => {
        while (queue.length && !me.cancelled) {
            const n = /** @type {string} */ (queue.shift());
            // Its own signal only: Home's latency reset (a node switch) is not a Stop.
            const d = await testProxy(n, PRECHECK_TIMEOUT, me.abort.signal, { shared: false, url: latencyUrl });
            if (Number.isFinite(d) && d >= 0 && d < 999999) {
                alive.add(n);
            } else if (!me.cancelled) {
                results.set(n, { state: 'skipped' });
                me.done++;
                emit();
            }
        }
    };
    await Promise.all(Array.from({ length: Math.min(PRECHECK_CONCURRENCY, list.length) }, worker));
    return alive;
}

/**
 * Downloads, one node at a time.
 * @param {Run} me
 * @param {string[]} nodes
 * @param {string} url
 * @param {number} maxSecs
 * @param {number | null} maxBytes the preset file's size (null: a custom address)
 * @param {number} generation native generation captured before the precheck
 */
async function downloadEach(me, nodes, url, maxSecs, maxBytes, generation) {
    for (const n of nodes) {
        if (me.cancelled) return;
        /** @type {SpeedEntry} */
        const entry = { state: 'testing' };
        results.set(n, entry);
        emit();
        /** @type {SpeedEntry | null} */
        let out;
        try {
            out = await withSpeedTestGroup(async () => {
                if (me.cancelled) return null;
                const node = await getProxyRecord(n);
                if (me.cancelled) return null;
                if (!node?.type || !isRealOutboundNode(n, node)) return { state: 'skipped' };
                await selectSpeedTestNode(n);
                // Stop pressed while the node was being selected: no new download.
                if (me.cancelled) return null;
                // The time limit starts with the download, not while waiting for the group.
                entry.startedAt = performance.now();
                const r = await speedTestDownload({ url, maxSecs, maxBytes, id: n, run: me.id, generation });
                if (r.cancelled) {
                    // The backend also cancels on reload, including a reload
                    // that fails and therefore sends no success event.
                    me.cancelled = true;
                    me.abort.abort();
                    me.wake();
                    return null;
                }
                return r.bytes > 0 ? { state: 'done', mbps: toMbps(r.peakBps), bps: r.peakBps } : { state: 'failed' };
            });
        } catch (err) {
            proxyLogger.warn(`[speed-test] ${n} failed`, err);
            out = { state: 'failed' };
        }
        // The run already ended (Stop did not wait for this step): it tidied up.
        if (run !== me) return;
        if (!out) {
            const old = me.prev.get(n);
            if (old) results.set(n, old);
            else results.delete(n);
            return;
        }
        results.set(n, out);
        me.done++;
        emit();
    }
}

/** Stop the run: the node being tested stops now, the rest are not tested. */
export async function stopSpeedTest() {
    if (!run) return;
    const me = run;
    me.cancelled = true;
    me.abort.abort();
    me.wake();
    emit();
    await speedTestCancel(me.id);
}
