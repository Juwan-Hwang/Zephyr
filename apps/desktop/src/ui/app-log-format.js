// @ts-check
/**
 * App-log (Logs → App) entry formatting: localized badge labels and messages
 * for Prism engine events and backend log levels.
 *
 * @module ui/app-log-format
 */

import { escapeHtml } from '../utils/sanitize.js';

/**
 * @typedef {{ type: string, message: string, timestamp: string, source?: string, data?: any }} AppLogEntry
 */

/** Prism event type → i18n key of its badge. */
const EVENT_LABEL_KEYS = Object.freeze({
    PatchApplied: ['appLogPatchApplied', 'Patch applied'],
    PatchFailed: ['appLogPatchFailed', 'Patch failed'],
    ConfigReloaded: ['appLogConfigReloaded', 'Config reloaded'],
    WatcherEvent: ['appLogWatcherEvent', 'File change'],
    WatcherStatus: ['appLogWatcherStatus', 'Watcher'],
    RulesChanged: ['appLogRulesChanged', 'Rules changed'],
});

/** Backend level → i18n key (same words as the level filter). */
const LEVEL_LABEL_KEYS = Object.freeze({
    debug: ['logLevelDebug', 'Debug'],
    info: ['logLevelInfo', 'Info'],
    warn: ['logLevelWarn', 'Warning'],
    error: ['logLevelError', 'Error'],
    fatal: ['logLevelFatal', 'Fatal'],
});

/** File change kind → i18n key. */
const CHANGE_KEYS = Object.freeze({
    create: ['appLogChangeCreate', 'Created'], created: ['appLogChangeCreate', 'Created'], add: ['appLogChangeCreate', 'Created'],
    modify: ['appLogChangeModify', 'Modified'], modified: ['appLogChangeModify', 'Modified'], change: ['appLogChangeModify', 'Modified'],
    remove: ['appLogChangeRemove', 'Removed'], removed: ['appLogChangeRemove', 'Removed'], delete: ['appLogChangeRemove', 'Removed'],
});

const CHANGE_COLORS = Object.freeze({ create: '#34d399', modify: '#f59e0b', remove: '#ef4444' });

/**
 * @param {Record<string, string>} t
 * @param {readonly string[]|undefined} pair
 * @param {string} raw
 */
function word(t, pair, raw) {
    if (!pair) return raw;
    return t[pair[0]] || pair[1];
}

/**
 * @param {string} tpl
 * @param {Record<string, string|number>} vars
 */
function fill(tpl, vars) {
    return tpl.replace(/@@(\w+)@@/g, (_, k) => String(vars[k] ?? ''));
}

/**
 * Badge text for an entry.
 * @param {AppLogEntry} entry
 * @param {Record<string, string>} t
 * @returns {string}
 */
export function appLogLabel(entry, t) {
    if (entry.source === 'backend') {
        return word(t, /** @type {any} */ (LEVEL_LABEL_KEYS)[String(entry.type).toLowerCase()], String(entry.type).toUpperCase());
    }
    return word(t, /** @type {any} */ (EVENT_LABEL_KEYS)[entry.type], entry.type);
}

/**
 * Log level an app-log entry filters as. Plain log entries carry their level as the
 * type; Prism events have none, so failures count as errors and the rest as info.
 * @param {AppLogEntry} entry
 * @returns {'debug'|'info'|'warn'|'error'|'fatal'}
 */
export function appLogLevel(entry) {
    const type = String(entry?.type || '').toLowerCase();
    if (type === 'debug' || type === 'info' || type === 'warn' || type === 'error' || type === 'fatal') return type;
    if (type === 'warning') return 'warn';
    if (type === 'patchfailed') return 'error';
    if (type === 'configreloaded') {
        const p = payloadOf(entry);
        if ((p?.success ?? p?.ok ?? true) === false) return 'error';
    }
    return 'info';
}

/**
 * Payload of a Prism event: `entry.data`, or JSON in `message` (older entries).
 * @param {AppLogEntry} entry
 * @returns {any|null}
 */
function payloadOf(entry) {
    if (entry.data && typeof entry.data === 'object') return entry.data;
    try {
        const parsed = JSON.parse(entry.message);
        return parsed && typeof parsed === 'object' ? parsed : null;
    } catch {
        return null;
    }
}

/**
 * @param {any} p
 * @param {Record<string, string>} t
 * @param {boolean} withLabels
 * @returns {{html: string, text: string}[]}
 */
function statParts(p, t, withLabels) {
    const added = Number(p.added ?? p.added_count ?? 0) || 0;
    const removed = Number(p.removed ?? p.removed_count ?? 0) || 0;
    const modified = Number(p.modified ?? p.modified_count ?? 0) || 0;
    /** @type {{html: string, text: string}[]} */
    const parts = [];
    /** @param {number} n @param {string} sign @param {string} color @param {string} key @param {string} fb */
    const push = (n, sign, color, key, fb) => {
        if (!n) return;
        const text = withLabels ? fill(t[key] || fb, { count: n }) : `${sign}${n}`;
        parts.push({ html: `<span style="color:${color}">${escapeHtml(text)}</span>`, text });
    };
    push(added, '+', '#34d399', 'appLogAdded', '+@@count@@ added');
    push(removed, '-', '#ef4444', 'appLogRemoved', '-@@count@@ removed');
    push(modified, '~', '#f59e0b', 'appLogModified', '~@@count@@ modified');
    return parts;
}

/**
 * Localized message for an entry, as safe HTML plus the plain text (for search).
 * @param {AppLogEntry} entry
 * @param {Record<string, string>} t
 * @returns {{html: string, text: string}}
 */
export function formatAppLogMessage(entry, t) {
    const plain = (/** @type {string} */ s) => ({ html: escapeHtml(s), text: s });

    if (entry.source === 'backend') {
        /** @type {Record<string, string>} */
        const levelColor = { error: '#ef4444', fatal: '#ef4444', warn: '#f59e0b', info: '#60a5fa' };
        const color = levelColor[entry.type] || '#a1a1aa';
        return { html: `<span style="color:${color}">&#9679;</span> ${escapeHtml(entry.message)}`, text: entry.message };
    }

    const p = payloadOf(entry);
    if (!p) return plain(entry.message);

    switch (entry.type) {
        case 'WatcherStatus': {
            const running = p.running ?? p.status === 'running';
            // watching_count counts directories, not files: no file count to show then.
            const count = p.file_count ?? p.files;
            let text = t.appLogWatcherStopped || 'Watching stopped';
            if (running) {
                text = count == null
                    ? (t.appLogWatcherStatus || 'Watcher')
                    : fill(t.appLogWatcherStarted || 'Watching @@count@@ files', { count });
            }
            const dot = `<span style="color:${running ? '#34d399' : '#ef4444'}">&#9679;</span>`;
            return { html: `${dot} ${escapeHtml(text)}`, text };
        }
        case 'RulesChanged': {
            const parts = statParts(p, t, true);
            if (!parts.length) {
                const none = t.appLogNoChanges || 'No changes';
                return { html: `<span style="color:#a1a1aa">${escapeHtml(none)}</span>`, text: none };
            }
            return { html: parts.map((x) => x.html).join(', '), text: parts.map((x) => x.text).join(', ') };
        }
        case 'PatchApplied': {
            const patchId = String(p.patch_id ?? p.id ?? '');
            const parts = statParts(p, t, false);
            const duration = p.duration ?? p.elapsed ?? '';
            const durText = duration ? ` ${fill(t.appLogDuration || 'in @@time@@', { time: String(duration) })}` : '';
            const stats = parts.length ? ` [${parts.map((x) => x.html).join(' ')}]` : '';
            const statsText = parts.length ? ` [${parts.map((x) => x.text).join(' ')}]` : '';
            return {
                html: `<b>${escapeHtml(patchId)}</b>${stats}${escapeHtml(durText)}`,
                text: `${patchId}${statsText}${durText}`.trim(),
            };
        }
        case 'PatchFailed': {
            const patchId = String(p.patch_id ?? p.id ?? '');
            const error = String(p.error ?? p.message ?? entry.message);
            return {
                html: `<b>${escapeHtml(patchId)}</b> — <span style="color:#ef4444">${escapeHtml(error)}</span>`,
                text: `${patchId} — ${error}`,
            };
        }
        case 'ConfigReloaded': {
            const success = p.success ?? p.ok ?? true;
            const msg = String(p.message ?? p.detail ?? '');
            const label = success ? (t.appLogReloadOk || 'Succeeded') : (t.appLogReloadFailed || 'Failed');
            const icon = success ? '<span style="color:#34d399">&#10003;</span>' : '<span style="color:#ef4444">&#10007;</span>';
            const tail = msg ? ` — ${msg}` : '';
            return { html: `${icon} ${escapeHtml(label + tail)}`, text: label + tail };
        }
        case 'WatcherEvent': {
            const file = String(p.file ?? p.path ?? '');
            const rawKind = String(p.change_type ?? p.kind ?? p.event ?? '');
            const pair = /** @type {any} */ (CHANGE_KEYS)[rawKind.toLowerCase()];
            const kind = pair ? word(t, pair, rawKind) : (rawKind || t.appLogChangeModify || 'Modified');
            const group = pair ? String(pair[0]).replace('appLogChange', '').toLowerCase() : '';
            const color = /** @type {any} */ (CHANGE_COLORS)[group] || '#22d3ee';
            return {
                html: `<span style="color:${color}">${escapeHtml(kind)}</span> <span class="font-mono">${escapeHtml(file)}</span>`,
                text: `${kind} ${file}`,
            };
        }
        default:
            return plain(entry.message);
    }
}
