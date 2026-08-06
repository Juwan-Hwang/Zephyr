// @ts-check
/**
 * Prism Engine — IPC utility module.
 *
 * Provides typed wrappers for all Prism IPC commands.
 * This is a pure utility module — no DOM, no page lifecycle.
 * UI modules (rule-library.js, subscriptions.js, etc.) import
 * what they need from here.
 *
 * @module ui/prism
 */

import { invoke } from '../api.js';
import { COMMANDS } from '@zephyr/shared';

/** @type {string[]} Cached trace from the last apply() call. Updated automatically. */
let _lastTrace = [];

// ═══════════════════════════════════════════════════════════════════════
//  Plugin System
// ═══════════════════════════════════════════════════════════════════════

/** Discover all plugins in the plugins directory. */
export async function pluginDiscover() {
    return invoke(COMMANDS.PLUGIN.DISCOVER);
}

/** Load a plugin by ID. */
export async function pluginLoad(/** @type {string} */ pluginId) {
    return invoke(COMMANDS.PLUGIN.LOAD, { pluginId });
}

/** Unload a plugin by ID. */
export async function pluginUnload(/** @type {string} */ pluginId) {
    return invoke(COMMANDS.PLUGIN.UNLOAD, { pluginId });
}

/** Enable or disable a plugin. */
export async function pluginEnable(/** @type {string} */ pluginId, /** @type {boolean} */ enable) {
    return invoke(COMMANDS.PLUGIN.ENABLE, { pluginId, enable });
}

/** Delete a plugin from disk. */
export async function pluginDelete(/** @type {string} */ pluginId) {
    return invoke(COMMANDS.PLUGIN.DELETE, { pluginId });
}

/** List all discovered plugins. */
export async function pluginListLoaded() {
    return invoke(COMMANDS.PLUGIN.LIST_LOADED);
}

/** Execute a plugin hook.
 *  @param {string} hookName
 *  @param {object} [context]
 *  @returns {Promise<any>}
 */
export async function pluginExecuteHook(hookName, context) {
    return invoke(COMMANDS.PLUGIN.EXECUTE_HOOK, { hookName, context: context ?? null });
}

/** List available hooks for a plugin.
 *  @param {string} pluginId
 *  @returns {Promise<string[]>}
 */
export async function pluginListHooks(pluginId) {
    return invoke(COMMANDS.PLUGIN.LIST_HOOKS, { pluginId });
}

/** Execute a plugin.
 *  @param {string} pluginId
 *  @returns {Promise<any>}
 */
export async function pluginExecute(pluginId) {
    return invoke(COMMANDS.PLUGIN.EXECUTE, { pluginId });
}

/** List all permissions declared by a plugin.
 *  @param {string} pluginId
 *  @returns {Promise<string[]>}
 */
export async function pluginListPermissions(pluginId) {
    return invoke(COMMANDS.PLUGIN.LIST_PERMISSIONS, { pluginId });
}

/** Check if a plugin has a specific permission.
 *  @param {string} pluginId
 *  @param {string} permission
 *  @returns {Promise<boolean>}
 */
export async function pluginCheckPermission(pluginId, permission) {
    return invoke(COMMANDS.PLUGIN.CHECK_PERMISSION, { pluginId, permission });
}

// ═══════════════════════════════════════════════════════════════════════
//  Script Engine
// ═══════════════════════════════════════════════════════════════════════

/** Execute a script against the running config.
 *  @param {string} script - JavaScript source code
 *  @param {string} scriptName - Name for logging
 *  @returns {Promise<{logs: Array<{level: string, message: string}>, duration_us: number, success: boolean, error: string|null, patches: Array<Record<string, unknown>>}>}
 */
export async function scriptExecute(script, scriptName) {
    return invoke(COMMANDS.SCRIPT.EXECUTE, { script, scriptName });
}

/** Validate a script for safety (no eval/Function/require).
 *  @param {string} script - JavaScript source code
 *  @returns {Promise<boolean>} true if safe
 */
export async function scriptValidate(script) {
    return invoke(COMMANDS.SCRIPT.VALIDATE, { script });
}

/** Get the current sandbox configuration. */
export async function scriptGetSandbox() {
    return invoke(COMMANDS.SCRIPT.GET_SANDBOX);
}

/** Set sandbox configuration.
 *  @param {object} config - { allowNetwork, allowFilesystem, allowChildProcess, allowWorkers }
 */
export async function scriptSetSandbox(config) {
    return invoke(COMMANDS.SCRIPT.SET_SANDBOX, config);
}

/** Get the current script execution limits. */
export async function scriptGetLimits() {
    return invoke(COMMANDS.SCRIPT.GET_LIMITS);
}

/** Set script execution limits.
 *  @param {object} limits - { maxExecTimeMs, maxMemoryMb, maxOutputBytes, maxLogLines }
 */
export async function scriptSetLimits(limits) {
    return invoke(COMMANDS.SCRIPT.SET_LIMITS, limits);
}

/** Grant a plugin permission to use the script engine.
 *  @param {string} pluginId
 */
export async function scriptGrantPlugin(pluginId) {
    return invoke(COMMANDS.SCRIPT.GRANT_PLUGIN, { pluginId });
}

/** Revoke a plugin's script engine permission.
 *  @param {string} pluginId
 */
export async function scriptRevokePlugin(pluginId) {
    return invoke(COMMANDS.SCRIPT.REVOKE_PLUGIN, { pluginId });
}

/** Check if a plugin has script engine permission.
 *  @param {string} pluginId
 *  @returns {Promise<boolean>}
 */
export async function scriptCheckPluginPermission(pluginId) {
    return invoke(COMMANDS.SCRIPT.CHECK_PLUGIN_PERMISSION, { pluginId });
}

/** Check if the current sandbox configuration is safe.
 *  @returns {Promise<boolean>}
 */
export async function scriptIsSandboxSafe() {
    return invoke(COMMANDS.SCRIPT.IS_SANDBOX_SAFE);
}

// ═══════════════════════════════════════════════════════════════════════
//  Smart Proxy Selector
// ═══════════════════════════════════════════════════════════════════════

/** Score a proxy node based on latency and success rate.
 *  @param {string} nodeName
 *  @param {number} latencyMs
 *  @param {boolean} success
 *  @returns {Promise<number>} Score 0.0-100.0
 */
export async function smartScore(nodeName, latencyMs, success) {
    return invoke(COMMANDS.SMART.SCORE, { nodeName, latencyMs, success });
}

/** Get the smart proxy selector configuration (smart.toml).
 *  @returns {Promise<object>}
 */
export async function smartConfig() {
    return invoke(COMMANDS.SMART.CONFIG);
}

/** Save smart proxy configuration to smart.toml.
 *  @param {object} configJson - Configuration object
 *  @returns {Promise<void>}
 */
export async function smartConfigSave(configJson) {
    return invoke(COMMANDS.SMART.CONFIG_SAVE, { configJson });
}

/** Calculate the next speed-test interval based on network quality.
 *  @param {number} networkQuality - 0.0 to 1.0
 *  @param {number} minInterval - Minimum interval in seconds
 *  @param {number} maxInterval - Maximum interval in seconds
 *  @returns {Promise<number>} Next interval in seconds
 */
export async function smartNextInterval(networkQuality, minInterval, maxInterval) {
    return invoke(COMMANDS.SMART.NEXT_INTERVAL, { networkQuality, minInterval, maxInterval });
}

/** Rank all nodes by smart score.
 *  @returns {Promise<Array<{name: string, score: number, rank: number}>>}
 */
export async function smartRank() {
    return invoke(COMMANDS.SMART.RANK);
}

/** Select the best node based on smart score.
 *  @returns {Promise<{name: string, score: number, successRate: number, p90Latency: number, stddev: number, recordCount: number} | null>}
 */
export async function smartSelectBest() {
    return invoke(COMMANDS.SMART.SELECT_BEST);
}

/** Clear all smart history data.
 *  @returns {Promise<void>}
 */
export async function smartClearHistory() {
    return invoke(COMMANDS.SMART.CLEAR_HISTORY);
}

/** Get a node's score at a specific point in time (for historical analysis).
 *  @param {string} nodeName
 *  @param {number} timestampSecs - Unix timestamp in seconds
 *  @returns {Promise<number>}
 */
export async function smartScoreAt(nodeName, timestampSecs) {
    return invoke(COMMANDS.SMART.SCORE_AT, { nodeName, timestampSecs });
}

/** Validate smart.toml configuration.
 *  @returns {Promise<string[]>} List of validation errors (empty if valid)
 */
export async function smartValidateConfig() {
    return invoke(COMMANDS.SMART.VALIDATE_CONFIG);
}

/** Get the adaptive scheduler configuration from smart.toml.
 *  @returns {Promise<object>}
 */
export async function smartSchedulerConfig() {
    return invoke(COMMANDS.SMART.SCHEDULER_CONFIG);
}

/** Trim history records to a maximum count.
 *  @param {number} maxRecords
 *  @returns {Promise<void>}
 */
export async function smartTrimHistory(maxRecords) {
    return invoke(COMMANDS.SMART.TRIM_HISTORY, { maxRecords });
}

// ═══════════════════════════════════════════════════════════════════════
//  Core operations
// ═══════════════════════════════════════════════════════════════════════

/** Apply all .prism.yaml patches and reload config. Options: { skipDisabled?: bool, validateOutput?: bool } */
export async function apply(/** @type {object|undefined} */ options = undefined) {
    const result = await invoke(COMMANDS.PRISM.APPLY, { options: options ?? null });
    // Cache trace for handleViewChanges — avoids recompilation on "View Impact".
    if (Array.isArray(result?.trace)) {
        _lastTrace = result.trace;
    }
    return result;
}

/** Get current Prism engine status. */
export async function status() {
    return invoke(COMMANDS.PRISM.STATUS);
}

/** Get Prism statistics (file count, rule count, etc.). */
export async function stats() {
    return invoke(COMMANDS.PRISM.GET_STATS);
}

// ═══════════════════════════════════════════════════════════════════════
//  Rule management
// ═══════════════════════════════════════════════════════════════════════

/** List all rules grouped by source file. */
export async function listRules() {
    return invoke(COMMANDS.PRISM.LIST_RULES);
}

/** Preview rule changes for a specific patch. */
export async function previewRules(/** @type {string} */ patchId) {
    return invoke(COMMANDS.PRISM.PREVIEW_RULES, { patchId });
}

/** Get cached trace from the last apply() — returns in-memory cache, no IPC. */
export async function getLastTrace() {
    return _lastTrace;
}

/** Check if a rule at the given index is managed by Prism. */
export async function isPrismRule(/** @type {number} */ index) {
    return invoke(COMMANDS.PRISM.IS_PRISM_RULE, { index });
}

/** Insert a structured rule at the specified position.
 *  @param {any} rule - JSON rule object or string
 *  @param {string} position - "before_prism" | "after_prism" | "after_group" | "append"
 *  @param {string} [groupId] - Required when position is "after_group"
 */
export async function insertRule(rule, position, groupId) {
    return invoke(COMMANDS.PRISM.INSERT_RULE, { rule, position, groupId: groupId ?? null });
}

/** Insert a rule from a string at the specified position.
 *  @param {string} ruleStr - Rule string, e.g. "DOMAIN-SUFFIX,example.com,REJECT"
 *  @param {string} position - "before_prism" | "after_prism" | "after_group" | "append"
 *  @param {string} [groupId] - Required when position is "after_group"
 */
export async function insertRuleStr(ruleStr, position, groupId) {
    return invoke(COMMANDS.PRISM.INSERT_RULE_STR, { ruleStr, position, groupId: groupId ?? null });
}

/** Toggle a rule group enabled/disabled. */
export async function toggleGroup(/** @type {string} */ groupId, /** @type {boolean} */ enabled) {
    return invoke(COMMANDS.PRISM.TOGGLE_GROUP, { groupId, enabled });
}

/** Rebuild: reset run_config.yaml to the original profile, then re-apply all patches.
 *  This produces a clean result — previously appended rules from disabled/skipped
 *  patches are properly removed. */
export async function rebuild(/** @type {object|undefined} */ options = undefined) {
    return invoke(COMMANDS.PRISM.REBUILD, { options: options ?? null });
}

// ═══════════════════════════════════════════════════════════════════════
//  Debug tools
// ═══════════════════════════════════════════════════════════════════════

/** Get a trace view for a specific patch (structured data). */
export async function traceReport(/** @type {string} */ patchId) {
    return invoke(COMMANDS.PRISM.TRACE_REPORT, { patchId });
}

/** Generate a full trace report text. */
export async function traceReportText() {
    return invoke(COMMANDS.PRISM.TRACE_REPORT_TEXT);
}

/** Validate a configuration string. */
export async function validateConfig(/** @type {string} */ config) {
    return invoke(COMMANDS.PRISM.VALIDATE_CONFIG, { config });
}

/** List all available profiles. */
export async function listProfiles() {
    return invoke(COMMANDS.PRISM.LIST_PROFILES);
}

/** Get core version info. */
export async function getCoreInfo() {
    return invoke(COMMANDS.PRISM.GET_CORE_INFO);
}

/** Read the raw YAML content of a profile. */
export async function readRawProfile(/** @type {string} */ profileId) {
    return invoke(COMMANDS.PRISM.READ_RAW_PROFILE, { profileId });
}

// ═══════════════════════════════════════════════════════════════════════
//  File watcher
// ═══════════════════════════════════════════════════════════════════════

/** Start watching the prism/ directory for changes.
 *  @param {number} [debounceMs=500] - Debounce interval in milliseconds
 */
export async function startWatching(/** @type {number|undefined} */ debounceMs) {
    return invoke(COMMANDS.PRISM.START_WATCHING, { debounceMs: debounceMs ?? null });
}

/** Stop watching the prism/ directory. */
export async function stopWatching() {
    return invoke(COMMANDS.PRISM.STOP_WATCHING);
}

/** Check if the watcher is currently active. */
export async function isWatching() {
    return invoke(COMMANDS.PRISM.IS_WATCHING);
}

// ═══════════════════════════════════════════════════════════════════════
//  Failover
// ═══════════════════════════════════════════════════════════════════════

/** Report a proxy test result to the failover engine.
 *  @param {string} nodeName
 *  @param {boolean} success
 *  @returns {Promise<{failedNode: string, failureCount: number, target: string}|null>}
 */
export async function failoverReport(nodeName, success) {
    return invoke(COMMANDS.FAILOVER.REPORT, { nodeName, success });
}

/** Get the current failover policy.
 *  @returns {Promise<object>}
 */
export async function failoverGetPolicy() {
    return invoke(COMMANDS.FAILOVER.GET_POLICY);
}

/** Set the failover policy.
 *  @param {object} policy
 */
export async function failoverSetPolicy(policy) {
    return invoke(COMMANDS.FAILOVER.SET_POLICY, policy);
}

/** Get the failure count for a node.
 *  @param {string} nodeName
 *  @returns {Promise<number>}
 */
export async function failoverFailureCount(nodeName) {
    return invoke(COMMANDS.FAILOVER.FAILURE_COUNT, { nodeName });
}

/** Reset all failover failure counts.
 *  @returns {Promise<void>}
 */
export async function failoverReset() {
    return invoke(COMMANDS.FAILOVER.RESET);
}

// ═══════════════════════════════════════════════════════════════════════
//  KV Store
// ═══════════════════════════════════════════════════════════════════════

/** Get a value from the KV store.
 *  @param {string} key
 *  @returns {Promise<string|null>}
 */
export async function kvGet(key) {
    return invoke(COMMANDS.KV.GET, { key });
}

/** Set a value in the KV store.
 *  @param {string} key
 *  @param {string} value
 */
export async function kvSet(key, value) {
    return invoke(COMMANDS.KV.SET, { key, value });
}

/** Delete a value from the KV store.
 *  @param {string} key
 */
export async function kvDelete(key) {
    return invoke(COMMANDS.KV.DELETE, { key });
}

/** List all keys in the KV store.
 *  @returns {Promise<string[]>}
 */
export async function kvKeys() {
    return invoke(COMMANDS.KV.KEYS);
}

// ═══════════════════════════════════════════════════════════════════════
//  Trace Advanced
// ═══════════════════════════════════════════════════════════════════════

/** Get trace statistics.
 *  @returns {Promise<object>}
 */
export async function traceStatistics() {
    return invoke(COMMANDS.TRACE_ADVANCED.STATISTICS);
}

/** Filter traces by source file.
 *  @param {string} source
 *  @returns {Promise<object>}
 */
export async function traceFilterBySource(source) {
    return invoke(COMMANDS.TRACE_ADVANCED.FILTER_BY_SOURCE, { source });
}

// ═══════════════════════════════════════════════════════════════════════
//  Override System
// ═══════════════════════════════════════════════════════════════════════

/**
 * @typedef {Object} OverrideItem
 * @property {string} id
 * @property {string} name
 * @property {'local'|'remote'} type
 * @property {'js'|'prismYaml'} ext
 * @property {boolean} enabled
 * @property {boolean} global
 * @property {string[]} profileIds
 * @property {string|null} url
 * @property {number} order
 * @property {number|null} updatedAt
 * @property {number} createdAt
 * @property {boolean|null} lastSuccess
 */

/**
 * @typedef {Object} OverrideLog
 * @property {string} scriptId
 * @property {string} scriptName
 * @property {number} executedAt
 * @property {number} durationUs
 * @property {boolean} success
 * @property {boolean} configModified
 * @property {string|null} error
 * @property {{level: string, message: string}[]} logs
 */

/** List all override items.
 *  @returns {Promise<OverrideItem[]>}
 */
export async function overrideList() {
    return invoke(COMMANDS.OVERRIDE.LIST);
}

/** Create a new override item.
 *  @param {string} name
 *  @param {'js'|'prism.yaml'} ext
 *  @param {'local'|'remote'} type
 *  @param {string|null} [url]
 *  @returns {Promise<OverrideItem>}
 */
export async function overrideCreate(name, ext, type, url = null) {
    return invoke(COMMANDS.OVERRIDE.CREATE, { name, ext, type, url });
}

/** Update override metadata.
 *  @param {string} id
 *  @param {Partial<{name: string, enabled: boolean, global: boolean, profileIds: string[], url: string}>} patch
 *  @returns {Promise<OverrideItem>}
 */
export async function overrideUpdate(id, patch) {
    return invoke(COMMANDS.OVERRIDE.UPDATE, { id, ...patch });
}

/** Delete an override item.
 *  @param {string} id
 */
export async function overrideDelete(id) {
    return invoke(COMMANDS.OVERRIDE.DELETE, { id });
}

/** Get override script content.
 *  @param {string} id
 *  @returns {Promise<string>}
 */
export async function overrideGetContent(id) {
    return invoke(COMMANDS.OVERRIDE.GET_CONTENT, { id });
}

/** Save override content and execute.
 *  @param {string} id
 *  @param {string} content
 *  @param {boolean} [dryRun]
 *  @returns {Promise<OverrideLog>}
 */
export async function overrideSetContent(id, content, dryRun = false) {
    return invoke(COMMANDS.OVERRIDE.SET_CONTENT, { id, content, dryRun });
}

/** Reorder override items.
 *  @param {string[]} ids - New order of override IDs
 */
export async function overrideReorder(ids) {
    return invoke(COMMANDS.OVERRIDE.REORDER, { ids });
}

/** Toggle override enabled/disabled.
 *  @param {string} id
 *  @param {boolean} enabled
 */
export async function overrideToggle(id, enabled) {
    return invoke(COMMANDS.OVERRIDE.TOGGLE, { id, enabled });
}

/** Test-execute an override without saving.
 *  @param {string} id
 *  @returns {Promise<OverrideLog>}
 */
export async function overrideTest(id) {
    return invoke(COMMANDS.OVERRIDE.TEST, { id });
}

/** Refresh a remote override (download + re-execute).
 *  @param {string} id
 *  @returns {Promise<OverrideLog>}
 */
export async function overrideRefreshRemote(id) {
    return invoke(COMMANDS.OVERRIDE.REFRESH_REMOTE, { id });
}

/** Apply all enabled overrides.
 *  @returns {Promise<OverrideLog[]>}
 */
export async function overrideApplyAll() {
    return invoke(COMMANDS.OVERRIDE.APPLY_ALL);
}

/** Export all overrides to a JSON file on disk.
 *  @returns {Promise<string>} Absolute path of the exported file
 */
export async function overrideExport() {
    return invoke(COMMANDS.OVERRIDE.EXPORT);
}

/** Import overrides from a JSON string.
 *  @param {string} json - Raw JSON content from the export file
 *  @returns {Promise<number>} Number of overrides imported
 */
export async function overrideImport(json) {
    return invoke(COMMANDS.OVERRIDE.IMPORT, { json });
}
