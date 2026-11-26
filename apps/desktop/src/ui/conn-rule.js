// @ts-check
/**
 * Connection detail: the rule a connection matched, with "Edit rule" and
 * "Add rule".
 *
 * - A rule from the rule library (a `.prism.yaml` file the user owns) can be
 *   edited in place: the file is read, that line replaced, written back and
 *   the library applied again — the same path as editing a rule in the
 *   library itself.
 * - A rule from the subscription, a rule set or MATCH cannot be edited here;
 *   the user can add a rule instead. Added rules go to the "My rules" file
 *   (created when missing) as `rules: { $prepend: [...] }`, first in the
 *   list, so they survive the next apply (profile switch, update, override
 *   change) — unlike a rule inserted only into the running config.
 *
 * @module ui/conn-rule
 */

import { invoke } from '../api.js';
import { COMMANDS } from '@zephyr/shared';
import { t, translations, currentLang } from '../i18n.js';
import { escapeHtml } from '../utils/sanitize.js';
import { showModal, showNotification } from './notifications.js';
import * as prism from './prism.js';
import { RULE_TYPES, ruleTypeLabel, parseRuleLine, buildRuleLine, loadPolicyNames, dropdownHtml, isPolicyOnlyType } from './rule-library/rule-form.js';
import { initCustomDropdown } from './dropdown.js';
import { fetchProxyGroups } from './proxy-groups.js';
import { rulesLogger } from '../utils/logger.js';

/** mihomo's rule names that do not follow the plain CamelCase → KEBAB-CASE pattern. */
const TYPE_SPECIAL = /** @type {Record<string, string>} */ ({
    ipcidr: 'IP-CIDR', ipcidr6: 'IP-CIDR6', srcipcidr: 'SRC-IP-CIDR', ipsuffix: 'IP-SUFFIX', ipasn: 'IP-ASN',
    geoip: 'GEOIP', geosite: 'GEOSITE', srcgeoip: 'SRC-GEOIP', ruleset: 'RULE-SET', match: 'MATCH',
    dstport: 'DST-PORT', srcport: 'SRC-PORT', inport: 'IN-PORT', processname: 'PROCESS-NAME', processpath: 'PROCESS-PATH',
    domainsuffix: 'DOMAIN-SUFFIX', domainkeyword: 'DOMAIN-KEYWORD', domainregex: 'DOMAIN-REGEX', domain: 'DOMAIN',
});

/** @param {string} s */
const norm = (s) => String(s || '').replace(/[-_\s]/g, '').toLowerCase();

/**
 * The config keyword for the rule name mihomo reports ("DomainSuffix" → "DOMAIN-SUFFIX").
 * @param {string} name
 * @returns {string}
 */
export function ruleKeyword(name) {
    const n = norm(name);
    if (!n) return 'MATCH';
    return TYPE_SPECIAL[n] || String(name).replace(/([a-z0-9])([A-Z])/g, '$1-$2').toUpperCase();
}

/**
 * The policy group a connection's rule sent it to (the last hop mihomo lists).
 * @param {any} conn
 */
export function rulePolicy(conn) {
    const chains = Array.isArray(conn?.chains) ? conn.chains : [];
    return chains.length ? String(chains[chains.length - 1]) : '';
}

/**
 * @typedef {{ kind: 'mine', file: string, label: string, raw: string }
 *   | { kind: 'set' } | { kind: 'match' } | { kind: 'sub' } | { kind: 'unknown' }} RuleSource
 */

/**
 * Where the rule a connection matched comes from.
 * @param {any} conn
 * @param {any[]} groups `prism.listRules()`: the library's rules in the running config
 * @returns {RuleSource}
 */
export function findRuleSource(conn, groups) {
    const keyword = ruleKeyword(conn?.rule);
    if (keyword === 'MATCH' || keyword === 'FINAL') return { kind: 'match' };
    if (keyword === 'RULE-SET') return { kind: 'set' };
    const payload = String(conn?.rulePayload || '');
    const policy = rulePolicy(conn);
    // Same case first. Then ignoring case, as mihomo reports a domain rule's
    // value in lower case; a process rule's value comes back as written, and
    // `/opt/Foo` and `/opt/foo` are two paths on Linux, so those match exactly.
    /** @type {Array<(v: string) => boolean>} */
    const tests = [(v) => v === payload];
    if (!norm(keyword).startsWith('process')) tests.push((v) => v.toLowerCase() === payload.toLowerCase());
    for (const same of tests) {
        for (const g of Array.isArray(groups) ? groups : []) {
            if (!g || typeof g !== 'object' || g.immutable || g.enabled === false || !g.group_id) continue;
            for (const r of g.rules || []) {
                const raw = String(r?.raw ?? r ?? '');
                const p = parseRuleLine(raw);
                if (norm(p.type) !== norm(keyword) || !same(p.value)) continue;
                // A `{{proxy}}`-style template resolves to a group only when applied.
                if (policy && p.policy && !isTemplate(p.policy) && p.policy !== policy) continue;
                return { kind: 'mine', file: String(g.group_id), label: String(g.label || g.group_id), raw };
            }
        }
    }
    return { kind: 'sub' };
}

/** @param {string} policy */
const isTemplate = (policy) => /\{\{.*\}\}/.test(policy);

/**
 * The ways "Add rule" offers to match this connection, most specific last.
 * @param {any} conn
 * @returns {Array<{ type: string, value: string }>}
 */
export function addOptions(conn) {
    const meta = conn?.metadata || {};
    const host = String(meta.host || '').trim().toLowerCase().replace(/\.$/, '');
    /** @type {Array<{ type: string, value: string }>} */
    const out = [];
    // An IP literal (IPv6 has letters too) gets an address rule below, not a domain one.
    if (host && !host.includes(':') && !/^[\d.]+$/.test(host)) {
        const parts = host.split('.');
        if (isPublicSuffix(parts) || underDeepShared(host)) {
            // `github.io`, `co.uk` itself, or a cloud tenant whose site boundary
            // is unknown: a suffix rule could take every site under it.
            out.push({ type: 'DOMAIN', value: host });
        } else {
            const site = siteLabels(parts);
            out.push({ type: 'DOMAIN-SUFFIX', value: parts.slice(-site).join('.') });
            out.push({ type: 'DOMAIN', value: host });
            if (parts.length >= site && site >= 2) out.push({ type: 'DOMAIN-KEYWORD', value: parts[parts.length - site] });
        }
    }
    const ip = String(meta.destinationIP || '').trim();
    if (ip) out.push(ip.includes(':') ? { type: 'IP-CIDR6', value: `${ip}/128` } : { type: 'IP-CIDR', value: `${ip}/32` });
    const proc = String(meta.process || '').trim();
    if (proc) out.push({ type: 'PROCESS-NAME', value: proc });
    // A comma or line break in a value would split the rule line: its policy
    // (or the rule itself) would come out wrong, so such an option is not offered.
    return out.filter((o) => !/[,\r\n]/.test(o.value));
}

/** Second-level labels used under country codes (`example.co.uk`, `site.com.cn`). */
const SECOND_LEVEL = new Set(['co', 'com', 'net', 'org', 'gov', 'edu', 'ac', 'or', 'ne', 'go', 'gob', 'gouv', 'mil', 'nic', 'ltd', 'plc', 'sch', 'info', 'biz', 'nom']);

/**
 * Shared hosting suffixes where every subdomain is someone else's site
 * (the common private entries of the public suffix list).
 */
const SHARED_SUFFIXES = new Set([
    'github.io', 'gitlab.io', 'githubusercontent.com', 'pages.dev', 'workers.dev', 'vercel.app', 'netlify.app',
    'herokuapp.com', 'appspot.com', 'blogspot.com', 'web.app', 'firebaseapp.com', 'azurewebsites.net',
    'cloudfront.net', 'fly.dev', 'onrender.com', 'glitch.me', 'repl.co', 'surge.sh', 'neocities.org',
    'wordpress.com', 'tumblr.com', 'substack.com', 'myshopify.com', 'r2.dev', 'deno.dev', 'ngrok.io', 'ngrok-free.app',
    // Registrar-run second levels and dynamic DNS, where each name is a different owner.
    'uk.com', 'us.com', 'eu.com', 'cn.com', 'de.com', 'jp.net', 'eu.org', 'za.com', 'br.com', 'ru.com', 'sa.com',
    'duckdns.org', 'ddns.net', 'no-ip.org', 'no-ip.biz', 'hopto.org', 'zapto.org', 'sytes.net', 'dynu.net',
    'dyndns.org', 'afraid.org', 'mooo.com', 'nip.io', 'sslip.io', 'trycloudflare.com', 'ngrok.app', 'loca.lt',
]);

/**
 * Clouds whose tenants sit at varying depths (`bucket.s3.amazonaws.com`,
 * `x.s3.us-east-1.amazonaws.com`): where one tenant's site ends is unknown
 * without the whole public suffix list, so only the exact host is offered.
 */
const DEEP_SHARED = ['amazonaws.com', 'googleusercontent.com', 'storage.googleapis.com', 'azureedge.net',
    'core.windows.net', 'cloudapp.azure.com', 'digitaloceanspaces.com', 'aliyuncs.com', 'myqcloud.com'];

/** @param {string} host */
function underDeepShared(host) {
    return DEEP_SHARED.some((d) => host === d || host.endsWith(`.${d}`));
}

/**
 * Whether the host is itself a shared suffix (`github.io`) or a country's
 * second level (`co.uk`), not anyone's site.
 * @param {string[]} parts
 */
function isPublicSuffix(parts) {
    if (parts.length !== 2) return parts.length < 2;
    return SHARED_SUFFIXES.has(parts.join('.')) || (parts[1].length === 2 && SECOND_LEVEL.has(parts[0]));
}

/**
 * How many trailing labels make up the site's own domain: two for
 * `api.example.com`, three for `api.example.co.uk` or `alice.github.io`, so
 * a suffix rule never covers a whole country's `co.uk` or every site on a
 * shared host.
 * @param {string[]} parts
 * @returns {number}
 */
function siteLabels(parts) {
    const n = parts.length;
    if (n <= 2) return n;
    const tld = parts[n - 1];
    const second = parts[n - 2];
    if (SHARED_SUFFIXES.has(`${second}.${tld}`)) return 3;
    return tld.length === 2 && SECOND_LEVEL.has(second) ? 3 : 2;
}

/** The "My rules" file name in every language, so one made in another language is still found. */
function myRulesNames() {
    const all = /** @type {Record<string, Record<string, unknown>>} */ (/** @type {unknown} */ (translations));
    return Object.values(all).map((d) => d?.connRuleMyRules).filter((v) => typeof v === 'string');
}

/**
 * The file name a "My rules" name is saved under: the backend keeps only
 * ASCII letters and digits, CJK, kana and Hangul (prism/types.rs
 * sanitize_filename), so a name it would change is saved as the English one,
 * which is found again in every language.
 * @param {string} name
 * @returns {string}
 */
export function myRulesFileName(name) {
    const kept = /^[A-Za-z0-9 ._()\u4e00-\u9fff\u3040-\u309f\u30a0-\u30ff\uac00-\ud7af\uf900-\ufaff-]+$/.test(name);
    const en = /** @type {any} */ (translations).en?.connRuleMyRules || 'My Rules';
    return `${kept && name.trim() ? name : en}.prism.yaml`;
}

/**
 * The existing "My rules" file, if any.
 * @param {Array<{ filename: string, enabled?: boolean }>} files
 * @returns {{ filename: string, enabled: boolean } | null}
 */
export function findMyRulesFile(files) {
    const names = new Set(myRulesNames().map((n) => `${n}.prism.yaml`));
    const f = (Array.isArray(files) ? files : []).find((x) => names.has(String(x?.filename || '')));
    return f ? { filename: String(f.filename), enabled: f.enabled !== false } : null;
}

/** Tail of the queue of rule-file edits: each reads and writes in turn. */
let fileQueue = Promise.resolve();

/**
 * Run one read-modify-write of a rule file after the one before it, so two
 * quick saves cannot both read the old content and lose one change.
 * @template T
 * @param {() => Promise<T>} fn
 * @returns {Promise<T>}
 */
function serially(fn) {
    const p = fileQueue.then(fn, fn);
    fileQueue = p.then(() => {}, () => {});
    return p;
}

/**
 * The rule file parsed as a mapping, or null (no YAML parser, not a mapping).
 * @param {string} content
 * @returns {Record<string, any> | null}
 */
function loadDoc(content) {
    if (typeof jsyaml === 'undefined') return null;
    try {
        const doc = jsyaml.load(content);
        return doc && typeof doc === 'object' && !Array.isArray(doc) ? /** @type {Record<string, any>} */ (doc) : null;
    } catch {
        return null;
    }
}

/** @param {Record<string, any>} doc */
const dumpDoc = (doc) => jsyaml.dump(doc, { lineWidth: -1, quotingType: "'", forceQuotes: false });

/**
 * `text` when it parses to `doc`, else `doc` written out afresh. A targeted
 * line edit keeps the user's comments and layout; a whole new dump loses
 * them, so it is only the fallback.
 * @param {string | null} text
 * @param {Record<string, any>} doc
 */
function keptOrDumped(text, doc) {
    if (text !== null) {
        try {
            if (JSON.stringify(jsyaml.load(text)) === JSON.stringify(doc)) return text;
        } catch { /* not valid: dumped below */ }
    }
    return dumpDoc(doc);
}

/** A list item line, `- value`, as YAML writes it (quoted when it must be). */
const itemText = (/** @type {string} */ rule) => jsyaml.dump([rule], { lineWidth: -1, quotingType: "'", forceQuotes: false }).replace(/\n$/, '').replace(/^- /, '');

/** `  - value  # note` -> its parts. */
const ITEM_LINE = /^(\s*-\s+)(.*?)(\s+#.*)?$/;

/**
 * The value of a list item line, or undefined.
 * @param {string} line
 */
function itemValue(line) {
    const m = ITEM_LINE.exec(line);
    if (!m) return undefined;
    try {
        const v = jsyaml.load(m[2]);
        return typeof v === 'string' ? v : undefined;
    } catch {
        return undefined;
    }
}

/**
 * `content` with `rule` as a new first item under its `$prepend:` key, or
 * null when there is no such key with items.
 * @param {string} content
 * @param {string} rule
 */
function prependText(content, rule) {
    const lines = content.split('\n');
    const keys = lines.flatMap((l, i) => (/^\s+\$prepend:\s*(?:#.*)?$/.test(l) ? [i] : []));
    if (keys.length !== 1) return null;
    for (let i = keys[0] + 1; i < lines.length; i++) {
        if (/^\s*(?:#.*)?$/.test(lines[i])) continue;
        const m = ITEM_LINE.exec(lines[i]);
        if (!m) return null;
        lines.splice(i, 0, `${m[1]}${itemText(rule)}`);
        return lines.join('\n');
    }
    return null;
}

/**
 * `content` with `rule` first in its `rules.$prepend` list; every other list
 * (`$append`, other keys) stays as it was. Null when the file cannot be parsed.
 * @param {string} content
 * @param {string} rule
 * @returns {string | null}
 */
export function prependRule(content, rule) {
    const doc = loadDoc(content);
    if (!doc) return null;
    const rules = doc.rules;
    if (Array.isArray(rules)) {
        // A plain list is appended (as the rule library reads it): it stays after the profile's rules.
        const rest = rules.map(String).filter((r) => r.trim() !== rule);
        doc.rules = rest.length ? { $prepend: [rule], $append: rest } : { $prepend: [rule] };
    } else if (rules && typeof rules === 'object') {
        /** @type {string[]} */
        const before = Array.isArray(rules.$prepend) ? rules.$prepend.map(String) : [];
        doc.rules = { ...rules, $prepend: [rule, ...before.filter((r) => r.trim() !== rule)] };
    } else {
        doc.rules = { $prepend: [rule] };
    }
    return keptOrDumped(prependText(content, rule), doc);
}

/**
 * Where `oldRaw` is across `lists`: an exact line in any list first; failing
 * that, the one rule in all of them with the same type and value whose policy
 * is a template (`{{proxy}}`) the running config showed resolved.
 * @param {string[][]} lists
 * @param {string} oldRaw
 * @returns {Array<{ list: number, i: number }>} one hit, or none
 */
function findRuleIn(lists, oldRaw) {
    for (let l = 0; l < lists.length; l++) {
        const i = lists[l].findIndex((r) => r.trim() === oldRaw.trim());
        if (i >= 0) return [{ list: l, i }];
    }
    const want = parseRuleLine(oldRaw);
    /** @type {Array<{ list: number, i: number }>} */
    const hits = [];
    lists.forEach((list, l) => list.forEach((r, i) => {
        const p = parseRuleLine(r);
        if (norm(p.type) === norm(want.type) && p.value === want.value && isTemplate(p.policy)) hits.push({ list: l, i });
    }));
    return hits.length === 1 ? hits : [];
}

/**
 * `content` with the line `oldRaw` replaced by `newRaw` wherever it sits
 * (`rules`, `$prepend`, `$append`); everything else stays. Null when the file
 * cannot be parsed; `undefined` when the line is not there.
 * @param {string} content
 * @param {string} oldRaw
 * @param {string} newRaw
 * @returns {string | null | undefined}
 */
export function replaceRule(content, oldRaw, newRaw) {
    const doc = loadDoc(content);
    if (!doc) return null;
    const rules = doc.rules;
    /** @type {any[][]} */
    const lists = Array.isArray(rules) ? [rules] : rules && typeof rules === 'object' ? Object.values(rules).filter(Array.isArray) : [];
    const [hit] = findRuleIn(lists.map((list) => list.map(String)), oldRaw);
    if (!hit) return undefined;
    const oldValue = String(lists[hit.list][hit.i]);
    lists[hit.list][hit.i] = newRaw;
    // Edit that one line in place; with duplicates, the one that gives this document.
    const lines = content.split('\n');
    for (let i = 0; i < lines.length; i++) {
        if (itemValue(lines[i]) !== oldValue) continue;
        const m = /** @type {RegExpExecArray} */ (ITEM_LINE.exec(lines[i]));
        const next = [...lines];
        next[i] = `${m[1]}${itemText(newRaw)}${m[3] || ''}`;
        const text = next.join('\n');
        if (keptOrDumped(text, doc) === text) return text;
    }
    return dumpDoc(doc);
}

/**
 * Put `rule` first in the "My rules" file (made when missing), then apply.
 * @param {string} rule
 * @returns {Promise<any>} the apply result
 */
export function addToMyRules(rule) {
    return serially(async () => {
        // A failed listing is an error, not "no file yet": creating it again would clash.
        const files = /** @type {any[]} */ (await invoke(COMMANDS.RULE_LIST));
        const existing = findMyRulesFile(files);
        if (existing && !existing.enabled) {
            throw new Error(t('connRuleMyRulesOff', { name: existing.filename.replace(/\.prism\.yaml$/, '') }));
        }
        if (existing) {
            const content = /** @type {string} */ (await invoke(COMMANDS.RULE_READ, { filename: existing.filename }));
            const next = prependRule(content, rule);
            // A file that does not parse is left as it is: rewriting it from
            // its text could drop its other keys or move its `$append` rules.
            if (next === null) throw new Error(t('notifRulesParseFailed'));
            await invoke(COMMANDS.RULE_UPDATE, { filename: existing.filename, content: next });
            const result = await applySaved();
            // Its `__when__` may leave the file out for this profile: say so
            // rather than report a rule that is not in use. The rule is saved
            // either way, so this is a notice, not an error to retry.
            if (loadDoc(content)?.__when__ !== undefined && !(await ruleInUse(existing.filename, rule))) {
                return { notApplied: t('connRuleMyRulesNotApplied', { name: existing.filename.replace(/\.prism\.yaml$/, '') }) };
            }
            return result;
        }
        await invoke(COMMANDS.RULE_CREATE, { name: myRulesFileName(t('connRuleMyRules')), content: `rules:\n  $prepend:\n    - ${JSON.stringify(rule)}\n` });
        return applySaved();
    });
}

/**
 * Apply after the file was written: a failed apply leaves the rule saved, so
 * it reports "not running yet" (restart notice) rather than an error the
 * dialog would offer to retry.
 * @returns {Promise<any>}
 */
async function applySaved() {
    try {
        return await prism.apply();
    } catch (e) {
        rulesLogger.warn('[conn-rule] apply failed', e);
        return { hot_reload_success: false };
    }
}

/**
 * Whether the running config holds `rule` from the library file `filename`.
 * @param {string} filename
 * @param {string} rule
 * @returns {Promise<boolean>} true when it cannot tell
 */
async function ruleInUse(filename, rule) {
    try {
        const groups = /** @type {any[]} */ (await prism.listRules()) || [];
        const g = groups.find((x) => x && (x.group_id === filename || x.patch_id === filename));
        return !!g && g.enabled !== false && (g.rules || []).some((/** @type {any} */ r) => String(r?.raw ?? r ?? '').trim() === rule);
    } catch {
        return true;
    }
}

/**
 * Replace one line of a library file, then apply.
 * @param {string} file @param {string} oldRaw @param {string} newRaw
 * @param {() => void} [onWritten] the file now holds `newRaw` (called before the apply)
 * @returns {Promise<any>} the apply result
 */
export function replaceInFile(file, oldRaw, newRaw, onWritten = () => {}) {
    return serially(async () => {
        const content = /** @type {string} */ (await invoke(COMMANDS.RULE_READ, { filename: file }));
        const next = replaceRule(content, oldRaw, newRaw);
        // A file that does not parse is left as it is for repair: rebuilding it
        // from its text could drop its other keys or move its other rules.
        if (next === null) throw new Error(t('notifRulesParseFailed'));
        if (!next) throw new Error(t('connRuleGone'));
        await invoke(COMMANDS.RULE_UPDATE, { filename: file, content: next });
        onWritten();
        // Apply builds on the running config, which still holds the old line:
        // rebuild from the profile so it goes, and run the overrides again.
        // A failed rebuild is not papered over with an apply (the old line
        // would keep matching): the file is saved, the next restart rebuilds.
        try {
            return await prism.rebuildWithOverrides();
        } catch (e) {
            rulesLogger.warn('[conn-rule] rebuild failed', e);
            return { hot_reload_success: false };
        }
    });
}

/**
 * The notice after a saved rule: success, or that the core has not taken it yet.
 * @param {any} result the apply result
 * @param {string} okKey
 */
function noticeAfterApply(result, okKey) {
    if (result?.notApplied) {
        showNotification(String(result.notApplied), 'warning');
        return;
    }
    const ok = result?.status?.hot_reload_success ?? result?.hot_reload_success;
    if (ok === false) showNotification(t('requireRestart'), 'warning');
    else showNotification(t(okKey), 'success');
}

/**
 * The modal sanitiser drops `role`, `tabindex` and a span's `id`: put the
 * radio-group semantics of the choice cards back after mounting.
 * @param {HTMLElement} area
 */
function restoreChoiceRoles(area) {
    const grid = area.querySelector('.choice-grid');
    const label = area.querySelector('[data-label="conn-rule-how"]');
    if (label) label.id = 'conn-rule-how';
    grid?.setAttribute('role', 'radiogroup');
    area.querySelectorAll('.choice-card').forEach((c) => {
        c.setAttribute('role', 'radio');
        /** @type {HTMLElement} */ (c).tabIndex = c.getAttribute('aria-checked') === 'true' ? 0 : -1;
    });
}

/**
 * The modal sanitiser applies NFKC, which changes valid names (`香港 ①` to
 * `香港 1`, a full-width path letter to ASCII): put a dropdown's exact values
 * and labels back after mounting, in the order they were written.
 * @param {HTMLElement} area
 * @param {string} id
 * @param {Array<{ value: string, label: string }>} options
 * @param {string} selected
 */
function restoreDropdown(area, id, options, selected) {
    const items = area.querySelectorAll(`#${id}-menu [data-value]`);
    const opts = /** @type {NodeListOf<HTMLOptionElement>} */ (area.querySelectorAll(`#${id}-select option`));
    options.forEach((o, i) => {
        const item = /** @type {HTMLElement | undefined} */ (items[i]);
        if (item) {
            item.dataset.value = o.value;
            item.dataset.label = o.label;
            item.textContent = o.label;
        }
        if (opts[i]) {
            opts[i].value = o.value;
            opts[i].textContent = o.label;
        }
    });
    const current = options.find((o) => o.value === selected) || options[0];
    const label = area.querySelector(`#${id}-label`);
    if (label && current) label.textContent = current.label;
    const select = /** @type {HTMLSelectElement | null} */ (area.querySelector(`#${id}-select`));
    if (select && current) select.value = current.value;
}

/** @returns {Record<string, string>} */
function dict() {
    const all = /** @type {any} */ (translations);
    return { ...(all.en || {}), ...(all[currentLang] || {}) };
}

/**
 * Markup for the rule card in the connection detail panel.
 * @param {any} conn
 * @param {RuleSource} src
 * @returns {string}
 */
export function ruleCardHtml(conn, src) {
    const tr = dict();
    const keyword = src.kind === 'mine' ? parseRuleLine(src.raw).type : ruleKeyword(conn?.rule);
    const value = src.kind === 'mine' ? parseRuleLine(src.raw).value : String(conn?.rulePayload || '');
    const typeText = keyword === 'MATCH' ? t('connRuleMatchAll') : ruleTypeLabel(keyword, tr);
    // The library could not be read: where the rule comes from is not known.
    const from = src.kind === 'mine' ? t('connRuleFromGroup', { name: src.label }) : src.kind === 'unknown' ? '' : t('connRuleFromSub');
    const note = src.kind === 'set' ? t('connRuleSetNote') : src.kind === 'match' ? t('connRuleMatchNote') : src.kind === 'sub' ? t('connRuleSubNote') : '';
    return `<section class="conn-rule-card" aria-labelledby="conn-rule-title">
        <div class="conn-rule-head"><h4 id="conn-rule-title">${escapeHtml(t('connRuleTitle'))}</h4>${from ? `<span class="conn-rule-src">${escapeHtml(from)}</span>` : ''}</div>
        <div class="conn-rule-line">
            <span class="conn-rule-type">${escapeHtml(typeText)}</span>
            ${value && keyword !== 'MATCH' ? `<code class="conn-rule-payload">${escapeHtml(value)}</code>` : ''}
            <span class="conn-rule-arrow" aria-hidden="true">→</span><span class="conn-rule-group">${escapeHtml((Array.isArray(conn?.chains) ? conn.chains.map(String) : []).join(' → ') || '-')}</span>
        </div>
        ${note ? `<p class="conn-rule-note">${escapeHtml(note)}</p>` : ''}
        <div class="conn-rule-actions">
            ${src.kind === 'mine' ? `<button type="button" class="btn-ghost conn-rule-btn" data-conn-rule="edit">${escapeHtml(t('connRuleEdit'))}</button>` : ''}
            ${src.kind === 'unknown' || !addOptions(conn).length ? '' : `<button type="button" class="btn-ghost conn-rule-btn" data-conn-rule="add">${escapeHtml(t('connRuleAdd'))}</button>`}
        </div>
    </section>`;
}

/** Bumped by every rule card shown: a dialog still loading for an older one does not open. */
let cardSeq = 0;

/**
 * Fill the rule card into `slot` and wire its buttons. `beforeDialog` runs
 * before a dialog opens (the detail panel closes so the dialog gets focus).
 * @param {HTMLElement} slot
 * @param {any} conn
 * @param {() => void} [beforeDialog]
 */
export async function mountRuleCard(slot, conn, beforeDialog = () => {}) {
    const seq = ++cardSeq;
    /** @type {any[]} */
    let groups = [];
    let listed = true;
    try {
        groups = /** @type {any[]} */ (await prism.listRules()) || [];
    } catch (e) {
        // Not "from the subscription": one of the user's own rules would
        // then offer only Add, writing a second rule beside it.
        listed = false;
        rulesLogger.warn('[conn-rule] list failed', e);
    }
    if (!slot.isConnected) return;
    /** @type {RuleSource} */
    let src = findRuleSource(conn, groups);
    if (!listed && src.kind === 'sub') src = { kind: 'unknown' };
    // eslint-disable-next-line no-unsanitized/property -- every value escaped in ruleCardHtml
    slot.innerHTML = ruleCardHtml(conn, src); // nosemgrep: js-innerhtml-assignment — escaped
    slot.querySelector('[data-conn-rule="add"]')?.addEventListener('click', () => { beforeDialog(); void openAddDialog(conn, seq); });
    if (src.kind === 'mine') slot.querySelector('[data-conn-rule="edit"]')?.addEventListener('click', () => { beforeDialog(); void openEditDialog(conn, src, seq); });
}

/** @param {HTMLElement} area */
function errorSlot(area) {
    const el = /** @type {HTMLElement | null} */ (area.querySelector('.conn-rule-error'));
    return (/** @type {string} */ msg) => {
        if (!el) return;
        el.textContent = msg;
        el.classList.toggle('hidden', !msg);
    };
}

/** @param {any} conn @param {number} [seq] the card it was opened from */
async function openAddDialog(conn, seq = cardSeq) {
    const tr = dict();
    const opts = addOptions(conn);
    if (!opts.length) return;
    const policies = await loadPolicyNames(() => fetchProxyGroups());
    // Another connection's detail was opened meanwhile: this dialog is not wanted.
    if (seq !== cardSeq) return;
    const current = rulePolicy(conn);
    const policyOptions = policies.map((p) => ({ value: p, label: p }));
    const policySelected = policies.includes(current) ? current : (policies[0] || 'DIRECT');
    const cards = opts.map((o, i) => `<button type="button" role="radio" aria-checked="${i === 0}" tabindex="${i === 0 ? 0 : -1}" class="choice-card" data-i="${i}">
        <span class="choice-card-title">${escapeHtml(ruleTypeLabel(o.type, tr))}</span><span class="choice-card-desc font-mono">${escapeHtml(o.value)}</span></button>`).join('');
    const html = `<div class="space-y-4 conn-rule-form">
        <p class="text-xs text-[var(--text-secondary)] truncate">${escapeHtml(String(conn?.metadata?.host || conn?.metadata?.destinationIP || ''))}</p>
        <div class="space-y-2"><span class="rl-field-label" data-label="conn-rule-how">${escapeHtml(t('connRuleHow'))}</span>
            <div class="choice-grid" role="radiogroup" aria-labelledby="conn-rule-how" style="--choice-cols:${Math.min(3, opts.length)}">${cards}</div></div>
        <div class="space-y-2"><span class="rl-field-label">${escapeHtml(t('connRulePolicy'))}</span>${dropdownHtml('conn-rule-policy', policyOptions, policySelected, t('connRulePolicy'))}</div>
        <p class="text-2xs text-[var(--text-muted)]">${escapeHtml(t('connRuleAddFoot', { name: t('connRuleMyRules') }))}</p>
        <div class="conn-rule-error hidden text-xs text-[var(--zephyr-color-danger)]" aria-live="polite"></div>
        <div class="flex items-center justify-end gap-2 pt-1">
            <button type="button" class="btn-ghost" data-act="cancel">${escapeHtml(t('cancel'))}</button>
            <button type="button" class="btn-primary" data-act="ok">${escapeHtml(t('connRuleAddConfirm'))}</button>
        </div></div>`;
    /** @type {any} */
    let dd = null;
    await showModal(t('connRuleAdd'), '', '', true, html, (area, close) => {
        restoreDropdown(area, 'conn-rule-policy', policyOptions, policySelected);
        area.querySelectorAll('.choice-card-desc').forEach((el, i) => { if (opts[i]) el.textContent = opts[i].value; });
        dd = initCustomDropdown({ wrapId: 'conn-rule-policy-wrap', triggerId: 'conn-rule-policy-trigger', menuId: 'conn-rule-policy-menu', labelId: 'conn-rule-policy-label', selectId: 'conn-rule-policy-select' });
        restoreChoiceRoles(area);
        const showError = errorSlot(area);
        let pick = 0;
        area.querySelectorAll('.choice-card').forEach((c) => c.addEventListener('click', () => {
            pick = Number(/** @type {HTMLElement} */ (c).dataset.i) || 0;
            area.querySelectorAll('.choice-card').forEach((o) => {
                const on = o === c;
                o.setAttribute('aria-checked', String(on));
                o.setAttribute('tabindex', on ? '0' : '-1');
            });
        }));
        area.querySelector('[data-act="cancel"]')?.addEventListener('click', () => close(null));
        const ok = /** @type {HTMLButtonElement | null} */ (area.querySelector('[data-act="ok"]'));
        ok?.addEventListener('click', async () => {
            const o = opts[pick];
            const rule = buildRuleLine(o.type, o.value, dd?.getValue() || current || 'DIRECT');
            ok.disabled = true;
            showError('');
            try {
                const result = await addToMyRules(rule);
                close(null);
                noticeAfterApply(result, 'connRuleAdded');
            } catch (e) {
                showError(String(/** @type {any} */ (e)?.message ?? e));
                ok.disabled = false;
            }
        });
    });
    dd?.dispose();
}

/**
 * @param {any} _conn
 * @param {{ kind: 'mine', file: string, label: string, raw: string }} src
 * @param {number} [seq] the card it was opened from
 */
async function openEditDialog(_conn, src, seq = cardSeq) {
    const tr = dict();
    const parsed = parseRuleLine(src.raw);
    const policies = await loadPolicyNames(() => fetchProxyGroups());
    if (seq !== cardSeq) return;
    if (parsed.policy && !policies.includes(parsed.policy)) policies.unshift(parsed.policy);
    const typeOptions = RULE_TYPES.map((r) => ({ value: r.value, label: ruleTypeLabel(r.value, tr) }));
    // A type the form does not offer (PROCESS-PATH, DOMAIN-REGEX…) stays as it is.
    if (parsed.type && !typeOptions.some((o) => o.value === parsed.type)) {
        typeOptions.unshift({ value: parsed.type, label: ruleTypeLabel(parsed.type, tr) });
    }
    const editPolicyOptions = policies.map((p) => ({ value: p, label: p }));
    const editPolicy = parsed.policy || policies[0] || 'DIRECT';
    const html = `<div class="space-y-4 conn-rule-form">
        <p class="text-xs text-[var(--text-secondary)] truncate">${escapeHtml(t('connRuleFromGroup', { name: src.label }))}</p>
        <div class="rl-insert-grid">
            <div class="space-y-2 min-w-0"><span class="rl-field-label">${escapeHtml(tr.ruleLibraryRuleType || 'Rule type')}</span>${dropdownHtml('conn-rule-type', typeOptions, parsed.type, tr.ruleLibraryRuleType || 'Rule type')}</div>
            <div class="space-y-2 min-w-0"><label class="rl-field-label" for="conn-rule-value">${escapeHtml(tr.ruleLibraryRuleMatch || 'Match')}</label>
                <input id="conn-rule-value" type="text" class="form-control form-control-lg form-control-mono" value="${escapeHtml(parsed.value)}" spellcheck="false" /></div>
        </div>
        <div class="space-y-2"><span class="rl-field-label">${escapeHtml(t('connRulePolicy'))}</span>${dropdownHtml('conn-rule-epolicy', editPolicyOptions, editPolicy, t('connRulePolicy'))}</div>
        <div class="conn-rule-error hidden text-xs text-[var(--zephyr-color-danger)]" aria-live="polite"></div>
        <div class="flex items-center justify-end gap-2 pt-1">
            <button type="button" class="btn-ghost" data-act="cancel">${escapeHtml(t('cancel'))}</button>
            <button type="button" class="btn-primary" data-act="ok">${escapeHtml(t('save'))}</button>
        </div></div>`;
    /** @type {any[]} */
    const dds = [];
    await showModal(t('connRuleEdit'), '', '', true, html, (area, close) => {
        const valueInput = /** @type {HTMLInputElement} */ (area.querySelector('#conn-rule-value'));
        // The exact stored value, not the sanitiser's normalised copy.
        valueInput.value = parsed.value;
        restoreDropdown(area, 'conn-rule-type', typeOptions, parsed.type);
        restoreDropdown(area, 'conn-rule-epolicy', editPolicyOptions, editPolicy);
        const typeDd = initCustomDropdown({
            wrapId: 'conn-rule-type-wrap', triggerId: 'conn-rule-type-trigger', menuId: 'conn-rule-type-menu', labelId: 'conn-rule-type-label', selectId: 'conn-rule-type-select',
            onChange: (/** @type {string} */ v) => { valueInput.disabled = isPolicyOnlyType(v); if (valueInput.disabled) valueInput.value = ''; },
        });
        const polDd = initCustomDropdown({ wrapId: 'conn-rule-epolicy-wrap', triggerId: 'conn-rule-epolicy-trigger', menuId: 'conn-rule-epolicy-menu', labelId: 'conn-rule-epolicy-label', selectId: 'conn-rule-epolicy-select' });
        if (typeDd) dds.push(typeDd);
        if (polDd) dds.push(polDd);
        const showError = errorSlot(area);
        // The line the file holds now: after a write whose apply failed, a
        // retry edits what was written.
        let baseline = src.raw;
        area.querySelector('[data-act="cancel"]')?.addEventListener('click', () => close(null));
        const ok = /** @type {HTMLButtonElement | null} */ (area.querySelector('[data-act="ok"]'));
        ok?.addEventListener('click', async () => {
            const type = typeDd?.getValue() || parsed.type;
            const value = valueInput.value.trim();
            if (!value && !isPolicyOnlyType(type)) { showError(tr.ruleLibraryInsertNeedValue || 'Enter what to match'); valueInput.focus(); return; }
            const next = buildRuleLine(type, isPolicyOnlyType(type) ? '' : value, polDd?.getValue() || parsed.policy, parsed.extra);
            ok.disabled = true;
            showError('');
            try {
                const result = await replaceInFile(src.file, baseline, next, () => { baseline = next; });
                close(null);
                noticeAfterApply(result, 'connRuleSaved');
            } catch (e) {
                showError(String(/** @type {any} */ (e)?.message ?? e));
                ok.disabled = false;
            }
        });
    });
    dds.forEach((d) => d.dispose());
}
