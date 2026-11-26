// @ts-check
/**
 * The exit address ("show IP address" in Settings, off by default): what
 * sites see while the current node is in use, looked up by the backend
 * through the proxy (ip-info.com, Cloudflare's trace as the fallback).
 *
 * - Nothing is looked up while the setting is off; turning it off drops
 *   every result (resetExitIp).
 * - One lookup per node, after the node has stayed put for a moment, and
 *   again only when the user asks (refreshExitIp). No polling.
 * - Results live in this module's memory only: never saved, never logged.
 * - The request goes through the hidden speed-test listener pinned to the
 *   node, so the site sees that node's address. DIRECT and other non-proxy
 *   exits (members of the hidden group too), groups, and a profile without
 *   the listener are never looked up.
 */

import { lookupExitIp, cancelExitIpLookups, speedTestPort, selectSpeedTestNode, getProxyRecord, SPECIAL_PROXY_NAMES } from '../api.js';
import { isRealOutboundNode } from './proxy-groups.js';
import { getSettingsCached } from './cache.js';
import { withSpeedTestGroup } from './speed-test.js';
import { createLogger } from '../utils/logger.js';
import { Bus, Events } from './events.js';

const logger = createLogger('ExitIp');

/** A node switch waits this long before its lookup, so quick switching asks once. */
export const EXIT_IP_SETTLE_MS = 1500;

/**
 * @typedef {{
 *   ip: string, country: string, source: string,
 *   country_name?: string, continent_name?: string, is_eu?: boolean,
 *   region?: string, region_code?: string, city?: string, district?: string,
 *   postal?: string, latitude?: number, longitude?: number, timezone?: string,
 *   asn?: number, as_name?: string, isp?: string, org?: string,
 *   connection_type?: string, user_type?: string, is_anycast?: boolean,
 * }} ExitIpInfo
 */

/** @type {Map<string, Promise<ExitIpInfo | null>>} */
const lookups = new Map();
/** Nodes whose lookup ran and found nothing (their null stays in `lookups`). */
/** @type {Set<string>} */
const failed = new Set();
/** Bumped by resetExitIp: a lookup started before it must not land. */
let generation = 0;
/** The node most recently asked about; an older one waiting to start is dropped. */
let latestLeaf = '';
let latestVisit = 0;
/** Visits whose automatic lookup has not completed yet. @type {Map<string, number>} */
const pendingVisits = new Map();
/** @type {Set<(leaf: string) => void>} */
const listeners = new Set();

/** @param {number} ms */
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Keep only the fields the UI knows, as plain values.
 * @param {any} r
 * @returns {ExitIpInfo | null}
 */
export function normalizeExitIp(r) {
    if (!r || typeof r.ip !== 'string' || !r.ip) return null;
    /** @type {any} */
    const out = { ip: r.ip, country: String(r.country || ''), source: String(r.source || '') };
    for (const k of ['country_name', 'continent_name', 'region', 'region_code', 'city', 'district', 'postal', 'timezone', 'as_name', 'isp', 'org', 'connection_type', 'user_type']) {
        if (typeof r[k] === 'string' && r[k].trim()) out[k] = r[k].trim();
    }
    for (const k of ['latitude', 'longitude', 'asn']) {
        if (typeof r[k] === 'number' && Number.isFinite(r[k])) out[k] = r[k];
    }
    for (const k of ['is_eu', 'is_anycast']) {
        if (typeof r[k] === 'boolean') out[k] = r[k];
    }
    return out;
}

/**
 * One lookup for `leaf`, through the speed-test listener pinned to that node,
 * so a rule that sends the lookup site DIRECT cannot report the user's own
 * address as the node's. Selecting the node and the request run as one step
 * of the hidden group's queue, so a download test cannot re-point it between.
 * @param {string} leaf
 * @param {() => boolean} stale true once the result is no longer wanted
 * @returns {Promise<ExitIpInfo | null>}
 */
async function lookup(leaf, stale) {
    // DIRECT is a member of the hidden group, so selecting it would succeed
    // and the lookup would leave over the user's own connection.
    if (SPECIAL_PROXY_NAMES.has(leaf.toUpperCase())) return null;
    const pinPort = await speedTestPort();
    if (!pinPort) return null;
    return withSpeedTestGroup(async () => {
        if (stale()) return null;
        try {
            // A node of a direct (or reject, ...) type under its own name, or a
            // group: never a proxy whose address the site would see.
            if (!isRealOutboundNode(leaf, await getProxyRecord(leaf))) return null;
            await selectSpeedTestNode(leaf);
        } catch {
            return null; // unknown to the core, or not a member of the hidden group
        }
        // Turned off (or the core restarted) meanwhile: send nothing.
        if (stale()) return null;
        return normalizeExitIp(await lookupExitIp(pinPort, leaf));
    });
}

/**
 * The address websites see while `leaf` is in use, or null when the
 * "show IP address" setting is off or the lookup failed. One lookup per node
 * (shared by both home pages) until the setting changes or the core restarts.
 * @param {string} leaf
 * @param {{ immediate?: boolean }} [opts] skip the settle delay (the user asked)
 * @returns {Promise<ExitIpInfo | null>}
 */
export function exitIpFor(leaf, { immediate = false } = {}) {
    if (!leaf) return Promise.resolve(null);
    if (latestLeaf !== leaf) {
        latestLeaf = leaf;
        latestVisit++;
    }
    const visit = latestVisit;
    const hit = lookups.get(leaf);
    if (hit !== undefined && (!pendingVisits.has(leaf) || pendingVisits.get(leaf) === visit)) return hit;
    const gen = generation;
    /** @type {Promise<ExitIpInfo | null> | undefined} */
    let run;
    run = (async () => {
        const settings = /** @type {any} */ (await getSettingsCached());
        if (!settings?.show_exit_ip) {
            // Off: nothing to keep per node (switching around must not grow the map).
            if (lookups.get(leaf) === run) lookups.delete(leaf);
            return null;
        }
        if (!immediate) {
            await sleep(EXIT_IP_SETTLE_MS);
            if (visit !== latestVisit || gen !== generation) {
                if (lookups.get(leaf) === run) lookups.delete(leaf);
                return null;
            }
        }
        // A switch away while this waited for the hidden group: not wanted any more.
        // Replaced by "look up again" before sending: that one asks instead.
        const r = await lookup(leaf, () => gen !== generation || lookups.get(leaf) !== run || (!immediate && visit !== latestVisit));
        if (gen !== generation || (!immediate && visit !== latestVisit)) {
            if (lookups.get(leaf) === run) lookups.delete(leaf);
            return null;
        }
        if (!r && lookups.get(leaf) === run) {
            // Given up for another node: nothing was learned. Otherwise the
            // miss is kept, so no page asks again on its own until a retry,
            // the user's "look up again", or a reset.
            if (!immediate && visit !== latestVisit) lookups.delete(leaf);
            else failed.add(leaf);
        }
        return r;
    })().catch((e) => {
        // The error text names the request, never the address.
        logger.debug('exit address lookup failed', String(e).slice(0, 120));
        if (lookups.get(leaf) === run) failed.add(leaf);
        return null;
    }).finally(() => {
        if (lookups.get(leaf) === run || !lookups.has(leaf)) pendingVisits.delete(leaf);
    });
    lookups.set(leaf, run);
    if (!immediate) pendingVisits.set(leaf, visit);
    else pendingVisits.delete(leaf);
    return run;
}

/**
 * Let the next `exitIpFor(leaf)` look again after a lookup that found
 * nothing (the one later retry). A found address is kept.
 * @param {string} leaf
 */
export function retryFailedExitIp(leaf) {
    if (!failed.delete(leaf)) return;
    lookups.delete(leaf);
}

/**
 * Look `leaf` up again now (the user's "look up again").
 * @param {string} leaf
 * @returns {Promise<ExitIpInfo | null>}
 */
export async function refreshExitIp(leaf) {
    lookups.delete(leaf);
    failed.delete(leaf);
    const r = await exitIpFor(leaf, { immediate: true });
    for (const fn of listeners) {
        try { fn(leaf); } catch (e) { logger.debug('exit address listener failed', e); }
    }
    return r;
}

/**
 * Called with the node whose address was looked up again.
 * @param {(leaf: string) => void} fn
 * @returns {() => void}
 */
export function onExitIpRefreshed(fn) {
    listeners.add(fn);
    return () => { listeners.delete(fn); };
}

/** Forget every looked-up address (the setting changed, or the core restarted). */
export function resetExitIp() {
    generation++;
    latestVisit++;
    latestLeaf = '';
    pendingVisits.clear();
    lookups.clear();
    failed.clear();
    // A lookup already in the backend sends no retry or fallback request either.
    void cancelExitIpLookups();
}

// Kept here, not on the home pages: neither may be mounted when the core
// restarts or reloads, and node names may then point at other servers.
Bus.on(Events.CORE_RESTARTED, resetExitIp);
Bus.on(Events.DIAGNOSTICS_INVALIDATED, resetExitIp);
Bus.on(Events.CONFIG_UPDATED, (/** @type {any} */ data) => { if (data?.reloaded) resetExitIp(); });
