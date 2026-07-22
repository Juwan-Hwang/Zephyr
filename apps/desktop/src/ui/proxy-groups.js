// @ts-check
/**
 * Proxy-group Resolver — determines the correct "main group" with full
 * deterministic reasoning instead of fragile keyword guessing.
 *
 * Key improvements over the old fetchProxyGroups:
 *   1. orderedGroups — from run_config.yaml proxy-groups order (deterministic)
 *   2. effectiveGroup — inferred from rules (FINAL/MATCH target)
 *   3. uiPrimaryGroup — stable primary group with fallback chain
 *   4. uiGroup — the group the UI actually operates on (from appStore or primary)
 *   5. Backward compatible — still returns `mainGroup` mapped to uiPrimaryGroup
 *
 * @module ui/proxy-groups
 */

import { getProxies, getConfig } from '../api.js';
import { getRunConfigCached } from './run-config-cache.js';

// ─── Helpers ───────────────────────────────────────────────────────────

/** Names that are always treated as special / non-selectable groups. */
const SPECIAL_GROUPS = new Set(['DIRECT', 'REJECT', 'PASS', 'COMPATIBLE']);

/**
 * Returns true if the proxy entry is a "group node" (has `all` array).
 * This includes selector, url-test, fallback, load-balance, relay, etc.
 * @param {any} p
 * @returns {boolean}
 */
export function isGroup(p) {
    return Array.isArray(p?.all);
}

/**
 * Returns true if the proxy type supports `PUT /proxies/{name}` to change `now`.
 * Only selector/select groups are writable via the mihomo API.
 * @param {string} type
 * @returns {boolean}
 */
export function isWritableGroupType(type = '') {
    const t = String(type).toLowerCase();
    return t === 'selector' || t === 'select';
}

/**
 * Keyword scoring for group name matching (last-resort fallback).
 * Higher score = better match as a "primary proxy selector group".
 * @param {string} name
 * @returns {number}
 */
function keywordScore(name) {
    const n = name.toLowerCase();
    // Negative keywords — groups that are clearly NOT the primary selector
    if (n.includes('auto') || n.includes('自动') || n.includes('url-test')
        || n.includes('fallback') || n.includes('load-balance') || n.includes('relay')
        || n.includes('流媒体') || n.includes('stream') || /\bai\b/.test(n)
        || n.includes('chatgpt') || n.includes('openai') || n.includes('telegram')
        || n.includes('discord') || n.includes('google') || n.includes('微软')
        || n.includes('apple') || n.includes('spotify') || n.includes('netflix')) {
        return -10;
    }
    // Positive keywords — groups that are likely the primary selector
    if (n.includes('proxy') || n.includes('节点') || n.includes('选') || n.includes('代理')
        || n.includes('select') || n.includes('selector')) {
        return 5;
    }
    return 0;
}

// ─── orderedGroups from run_config ─────────────────────────────────────

/**
 * Build an ordered list of group names from the run_config proxy-groups section.
 * This preserves the YAML definition order — the deterministic backbone.
 *
 * @param {any} runConfig - The run_config.yaml JSON
 * @param {Record<string, any>} proxyMap - The /proxies response map
 * @returns {string[]} Ordered group names (writable groups first, then all groups)
 */
function buildOrderedGroups(runConfig, proxyMap) {
    const seen = new Set();
    const writable = [];
    const all = [];

    // 1. From run_config proxy-groups YAML order
    if (runConfig && Array.isArray(runConfig['proxy-groups'])) {
        for (const pg of runConfig['proxy-groups']) {
            const name = pg?.name;
            if (!name || SPECIAL_GROUPS.has(name.toUpperCase())) continue;
            if (seen.has(name)) continue;
            seen.add(name);

            const p = proxyMap[name];
            if (!p || !isGroup(p)) continue;
            if (p.hidden) continue;

            all.push(name);
            if (isWritableGroupType(p.type)) {
                writable.push(name);
            }
        }
    }

    // 2. Fallback: GLOBAL.all (preserves subscription-defined order)
    if (all.length === 0 && proxyMap['GLOBAL']?.all) {
        for (const name of proxyMap['GLOBAL'].all) {
            if (SPECIAL_GROUPS.has(name.toUpperCase())) continue;
            if (seen.has(name)) continue;
            const p = proxyMap[name];
            if (!p || !isGroup(p)) continue;
            if (p.hidden) continue;
            seen.add(name);
            all.push(name);
            if (isWritableGroupType(p.type)) {
                writable.push(name);
            }
        }
    }

    // 3. Last resort: all group nodes from proxyMap, sorted by name
    if (all.length === 0) {
        for (const name of Object.keys(proxyMap).sort()) {
            if (SPECIAL_GROUPS.has(name.toUpperCase())) continue;
            const p = proxyMap[name];
            if (!isGroup(p)) continue;
            if (p.hidden) continue;
            if (seen.has(name)) continue;
            seen.add(name);
            all.push(name);
            if (isWritableGroupType(p.type)) {
                writable.push(name);
            }
        }
    }

    // Writable groups first, then non-writable groups — preserves YAML order
    const writableSet = new Set(writable);
    const result = [...writable];
    for (const name of all) {
        if (!writableSet.has(name)) {
            result.push(name);
        }
    }
    return result;
}

// ─── effectiveGroup from rules ──────────────────────────────────────────

/**
 * Infer the effective (rules default) outbound group from run_config rules.
 * Looks for the last FINAL or MATCH rule and returns its target group name.
 *
 * @param {any} runConfig - The run_config.yaml JSON
 * @param {Record<string, any>} proxyMap - The /proxies response map
 * @returns {string|null} The effective group name, or null if undetermined
 */
function inferEffectiveGroup(runConfig, proxyMap) {
    if (!runConfig || !Array.isArray(runConfig.rules)) return null;

    // Scan rules from the end — FINAL/MATCH is typically the last rule
    for (let i = runConfig.rules.length - 1; i >= 0; i--) {
        const rule = String(runConfig.rules[i] || '').trim();
        const upper = rule.toUpperCase();

        if (!upper.startsWith('FINAL') && !upper.startsWith('MATCH')) continue;

        // Parse: "FINAL,GroupName" or "MATCH,GroupName" or "FINAL,GroupName,no-resolve"
        // Use a regex to extract the group name, supporting quoted names (e.g.,
        // FINAL,"My, Group",no-resolve) and names without quotes.
        const match = rule.match(/^(?:FINAL|MATCH),\s*(?:"([^"]+)"|'([^']+)'|([^,]+))\s*(?:,|$)/i);
        if (!match) continue;

        // matched groups: [1]=double-quoted, [2]=single-quoted, [3]=unquoted
        const candidate = (match[1] || match[2] || match[3] || '').trim();
        if (!candidate) continue;

        // Verify the target is a known group node
        const p = proxyMap[candidate];
        if (p && isGroup(p)) return candidate;
    }

    return null;
}

// ─── topLevelGroups ────────────────────────────────────────────────────

/**
 * Build the list of "top-level" groups shown in the UI group selector.
 * Uses GLOBAL.all as the primary source, supplemented by orderedGroups.
 *
 * @param {Record<string, any>} proxyMap
 * @param {string[]} orderedGroups
 * @returns {string[]}
 */
function buildTopLevelGroups(proxyMap, orderedGroups) {
    const seen = new Set();
    const result = [];

    // 1. GLOBAL.all items that are also groups (preserves subscription order)
    if (proxyMap['GLOBAL']?.all) {
        for (const name of proxyMap['GLOBAL'].all) {
            if (SPECIAL_GROUPS.has(name.toUpperCase())) continue;
            const p = proxyMap[name];
            if (!p || !isGroup(p)) continue;
            if (p.hidden) continue;
            if (seen.has(name)) continue;
            seen.add(name);
            result.push(name);
        }
    }

    // 2. Supplement with orderedGroups (dedup)
    for (const name of orderedGroups) {
        if (seen.has(name)) continue;
        seen.add(name);
        result.push(name);
    }

    return result;
}

// ─── uiPrimaryGroup determination ──────────────────────────────────────

/**
 * Determine the primary UI group — the group that the node list should
 * operate on by default.  Uses a priority chain:
 *
 *   1. preferredGroupName (UI explicit selection)
 *   2. primaryGroupPreference (user preference)
 *   3. effectiveGroup (from rules)
 *   4. orderedGroups[0]
 *   5. topLevelGroups[0]
 *   6. keyword scoring best match
 *   7. first writable group by name
 *
 * @param {Object} ctx
 * @param {string|null} ctx.preferredGroupName
 * @param {string|null} ctx.primaryGroupPreference
 * @param {string|null} ctx.effectiveGroupName
 * @param {string[]} ctx.orderedGroups
 * @param {string[]} ctx.topLevelGroups
 * @param {Record<string, any>} ctx.proxyMap
 * @returns {{ name: string|null, reason: { source: string, detail: string } }}
 */
function determineUiPrimaryGroup(ctx) {
    const {
        preferredGroupName,
        primaryGroupPreference,
        effectiveGroupName,
        orderedGroups,
        topLevelGroups,
        proxyMap,
    } = ctx;

    // Validate a candidate group name: must exist in proxyMap and be a writable group
    const isValidWritable = (/** @type {string|null} */ name) =>
        name && proxyMap[name] && isWritableGroupType(proxyMap[name].type) && !proxyMap[name].hidden;

    // 1. preferredGroupName (UI explicit selection) — must be writable
    if (isValidWritable(preferredGroupName)) {
        return { name: /** @type {string} */ (preferredGroupName), reason: { source: 'preferred', detail: 'User explicitly selected this group in UI' } };
    }

    // 2. primaryGroupPreference
    if (isValidWritable(primaryGroupPreference)) {
        return { name: /** @type {string} */ (primaryGroupPreference), reason: { source: 'preference', detail: 'Saved primary group preference' } };
    }

    // 3. effectiveGroup (from rules) — must be writable (selector/select)
    // Non-writable groups (url-test, fallback, etc.) cannot be switched via
    // PUT /proxies/{group}, so they must not be used as the uiGroup.
    if (isValidWritable(effectiveGroupName)) {
        return { name: effectiveGroupName, reason: { source: 'effective', detail: 'Inferred from FINAL/MATCH rule in config' } };
    }

    // 4. orderedGroups[0]
    if (orderedGroups.length > 0 && isValidWritable(orderedGroups[0])) {
        return { name: orderedGroups[0], reason: { source: 'ordered', detail: 'First writable group from run_config proxy-groups order' } };
    }

    // 5. topLevelGroups[0]
    if (topLevelGroups.length > 0 && isValidWritable(topLevelGroups[0])) {
        return { name: topLevelGroups[0], reason: { source: 'topLevel', detail: 'First writable group from GLOBAL.all' } };
    }

    // 6. Keyword scoring across all writable groups
    const allWritable = Object.keys(proxyMap)
        .filter(name => isWritableGroupType(proxyMap[name]?.type) && !proxyMap[name]?.hidden)
        .sort();
    if (allWritable.length > 0) {
        let bestName = allWritable[0];
        let bestScore = keywordScore(bestName);
        for (const name of allWritable.slice(1)) {
            const score = keywordScore(name);
            if (score > bestScore) {
                bestScore = score;
                bestName = name;
            }
        }
        return { name: bestName, reason: { source: 'keyword', detail: `Best keyword match (score=${bestScore})` } };
    }

    // No writable group found — return null rather than a non-writable group
    // (url-test/fallback/load-balance groups cannot be switched via PUT /proxies/{group},
    // and presenting them as actionable targets creates a broken interactive path).
    return { name: null, reason: { source: 'fallback', detail: 'No writable proxy groups found' } };
}

// ─── Public API ────────────────────────────────────────────────────────

/**
 * @typedef {Object} ResolverOutput
 * @property {Object}  data                  - Raw /proxies response
 * @property {Object}  config                - Raw /configs response
 * @property {string[]} groups               - All selector-type group names (legacy compat)
 * @property {string|null}  mainGroup             - Primary group name (legacy compat → uiPrimaryGroupName)
 * @property {string[]} proxies              - Candidates of the uiGroup (mainGroup)
 * @property {string|null} current           - Current `now` of the uiGroup
 *
 * @property {string[]} orderedGroupNames    - Groups in run_config YAML order
 * @property {string[]} topLevelGroupNames   - Top-level groups for group selector UI
 * @property {string|null} effectiveGroupName - Inferred from FINAL/MATCH rule
 * @property {string|null}  uiPrimaryGroupName    - Determined primary group (null if no writable groups)
 * @property {string|null}  uiGroupName           - Actually used UI group (GLOBAL in global mode, or primary)
 * @property {{source:string, detail:string}} reason - Why this primary group was chosen
 * @property {Record<string, string[]>} graph - Group → children adjacency list
 * @property {boolean} providerLoading - True when uiGroup uses include-all and all[] is empty
 */

/**
 * Resolve proxy groups with full deterministic reasoning.
 *
 * @param {Object} options
 * @param {Object} [options.existingData]         - Pre-fetched /proxies data
 * @param {Object} [options.existingConfig]       - Pre-fetched /configs data
 * @param {string} [options.preferredGroupName]    - UI currently selected group
 * @param {string} [options.primaryGroupPreference] - Saved user preference
 * @returns {Promise<ResolverOutput|null>}
 */
export async function fetchProxyGroups(options = {}) {
    /** @type {{proxies?: Record<string, {type?: string, all?: string[], now?: string|null, hidden?: boolean}>}} */
    const data = options.existingData || await getProxies();
    if (!data || !data.proxies) {
        return null;
    }

    /** @type {{mode?: string}} */
    const config = options.existingConfig || await getConfig();

    const proxyMap = data.proxies;

    // Read run_config for deterministic ordering and rules
    const runConfig = await getRunConfigCached();

    // --- orderedGroups (deterministic backbone) ---
    const orderedGroupNames = buildOrderedGroups(runConfig, proxyMap);

    // --- topLevelGroups ---
    const topLevelGroupNames = buildTopLevelGroups(proxyMap, orderedGroupNames);

    // --- effectiveGroup (from rules) ---
    const effectiveGroupName = inferEffectiveGroup(runConfig, proxyMap);

    // --- Legacy groups list (all selector-type groups) ---
    const groups = Object.keys(proxyMap).filter(name => {
        const p = proxyMap[name];
        return p && isWritableGroupType(p.type) && !p.hidden;
    });

    // --- uiPrimaryGroup ---
    // In non-global mode, GLOBAL is not a valid preferred group — it's a
    // stale leftover from a prior global-mode session.  Let the resolver
    // fall through to effective/ordered instead.
    const isGlobalMode = config?.mode?.toLowerCase() === 'global';
    const preferredForResolver = (!isGlobalMode && options.preferredGroupName === 'GLOBAL')
        ? null
        : (options.preferredGroupName || null);

    const { name: uiPrimaryGroupName, reason } = determineUiPrimaryGroup({
        preferredGroupName: preferredForResolver,
        primaryGroupPreference: options.primaryGroupPreference || null,
        effectiveGroupName,
        orderedGroups: orderedGroupNames,
        topLevelGroups: topLevelGroupNames,
        proxyMap,
    });

    // --- uiGroup (the group the UI actually operates on) ---
    // In global mode, ALL traffic is routed through the GLOBAL group.
    // The user must operate on GLOBAL to affect actual routing.
    let uiGroupName = uiPrimaryGroupName;
    if (isGlobalMode && proxyMap['GLOBAL']) {
        uiGroupName = 'GLOBAL';
    }

    // --- Build graph (group → children adjacency) ---
    /** @type {Record<string, string[]>} */
    const graph = {};
    for (const name of Object.keys(proxyMap)) {
        const p = proxyMap[name];
        if (isGroup(p) && p.all) {
            graph[name] = [...p.all];
        }
    }

    // --- Resolve candidates for the uiGroup ---
    // Gracefully handle null uiGroupName (no writable groups found)
    const targetGroup = uiGroupName ? proxyMap[uiGroupName] : null;
    const proxies = targetGroup?.all || [];
    const current = targetGroup?.now || null;

    // --- Detect provider-loading state ---
    // Groups with `include-all: true` or `include-all-providers: true` depend
    // on proxy-providers finishing their HTTP download before their `all`
    // array is populated.  If such a group has an empty `all` array while
    // the config defines proxy-providers, the nodes are still loading.
    const hasProxyProviders = !!(runConfig && runConfig['proxy-providers']
        && Object.keys(runConfig['proxy-providers']).length > 0);
    const includeAllGroups = buildIncludeAllSet(runConfig);
    const isIncludeAllGroup = uiGroupName
        ? (uiGroupName === 'GLOBAL' || includeAllGroups.has(uiGroupName))
        : false;
    const providerLoading = hasProxyProviders && isIncludeAllGroup && proxies.length === 0;

    return {
        // Legacy compat fields
        data,
        config,
        groups,
        mainGroup: uiGroupName,  // Backward compat — matches uiGroup (GLOBAL in global mode)
        proxies,
        current,

        // New resolver fields
        orderedGroupNames,
        topLevelGroupNames,
        effectiveGroupName,
        uiPrimaryGroupName,
        uiGroupName,
        reason,
        graph,

        // Provider loading state — true when the uiGroup uses include-all
        // and its all[] is empty (nodes still being downloaded by mihomo)
        providerLoading,
    };
}

/**
 * Build a Set of group names that use `include-all` or `include-all-providers`.
 * Precomputed once per fetchProxyGroups call to avoid repeated linear scans.
 *
 * @param {any} runConfig - The run_config.yaml JSON
 * @returns {Set<string>}
 */
export function buildIncludeAllSet(runConfig) {
    const result = new Set();
    if (!runConfig || !Array.isArray(runConfig['proxy-groups'])) return result;
    for (const pg of runConfig['proxy-groups']) {
        if (pg?.name && (pg['include-all'] || pg['include-all-providers'])) {
            result.add(pg.name);
        }
    }
    return result;
}
