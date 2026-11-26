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

import { invoke, coreReplacements, getConnections } from '../api.js';
import { COMMANDS } from '@zephyr/shared';
import { t, translations, currentLang } from '../i18n.js';
import { escapeHtml } from '../utils/sanitize.js';
import { showModal, showNotification } from './notifications.js';
import * as prism from './prism.js';
import { RULE_TYPES, ruleTypeLabel, parseRuleLine, buildRuleLine, loadPolicyNames, dropdownHtml, isPolicyOnlyType } from './rule-library/rule-form.js';
import { initCustomDropdown } from './dropdown.js';
import { fetchProxyGroups } from './proxy-groups.js';
import { rulesLogger } from '../utils/logger.js';
import { queueRuleWrite } from './rule-library/write-queue.js';
import { isYamlCollection } from './rule-library/yaml-utils.js';
import { loadPrismYaml } from './rule-library/yaml-schema.js';
import { Bus, Events, currentRulesVersion } from './events.js';

// Older supported WebViews do not provide Object.hasOwn.
const hasOwn = (/** @type {object} */ object, /** @type {string} */ key) => Object.prototype.hasOwnProperty.call(object, key); // NOSONAR — WebView compatibility

/** mihomo's rule names that do not follow the plain CamelCase → KEBAB-CASE pattern. */
const TYPE_SPECIAL = /** @type {Record<string, string>} */ ({
    ipcidr: 'IP-CIDR', ipcidr6: 'IP-CIDR6', srcipcidr: 'SRC-IP-CIDR', ipsuffix: 'IP-SUFFIX', ipasn: 'IP-ASN',
    geoip: 'GEOIP', geosite: 'GEOSITE', srcgeoip: 'SRC-GEOIP', ruleset: 'RULE-SET', match: 'MATCH',
    dstport: 'DST-PORT', srcport: 'SRC-PORT', inport: 'IN-PORT', processname: 'PROCESS-NAME', processpath: 'PROCESS-PATH',
    domainsuffix: 'DOMAIN-SUFFIX', domainkeyword: 'DOMAIN-KEYWORD', domainregex: 'DOMAIN-REGEX', domain: 'DOMAIN',
});

/** @param {string} s */
const norm = (s) => String(s || '').replace(/[-_\s]/g, '').toLowerCase();

/** IPv6 CIDR rows use IPCIDR in the core's rule API too. @param {string} type */
const ruleType = (type) => norm(type) === 'ipcidr6' ? 'ipcidr' : norm(type);

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
 * @typedef {{ kind: 'mine', file: string, label: string, raw: string, openedContent?: string, rulesRevision?: number }
 *   | { kind: 'override', file: string, label: string, raw: string }
 *   | { kind: 'set' } | { kind: 'match' } | { kind: 'sub' } | { kind: 'unknown' }} RuleSource
 */

/**
 * Where the rule a connection matched comes from.
 * @param {any} conn
 * @param {any[]} groups `prism.listRules()`: the library's rules in the running config
 * @param {unknown[] | null} [runningRules] runtime array accompanying the annotations
 * @returns {RuleSource}
 */
export function findRuleSource(conn, groups, runningRules = null) {
    const keyword = ruleKeyword(conn?.rule);
    if (keyword === 'MATCH' || keyword === 'FINAL') return { kind: 'match' };
    if (keyword === 'RULE-SET') return { kind: 'set' };
    const payload = String(conn?.rulePayload || '');
    const policy = rulePolicy(conn);
    // Only literal domain matches ignore case. Regex escapes (`\d` / `\D`),
    // process paths and other opaque payloads must be compared as written.
    /** @type {Array<(v: string) => boolean>} */
    const tests = [(v) => sameRuleValue(keyword, v, payload)];
    /** @type {{ src: RuleSource, at: number } | null} */
    let first = null;
    for (const same of tests) {
        for (const g of Array.isArray(groups) ? groups : []) {
            if (!g || typeof g !== 'object' || g.enabled === false || !g.group_id) continue;
            for (const r of g.rules || []) {
                const raw = String(r?.raw ?? r ?? '');
                const p = parseRuleLine(raw);
                if (ruleType(p.type) !== ruleType(keyword) || !same(p.value)) continue;
                // A `{{proxy}}`-style template resolves to a group only when applied.
                if (policy && p.policy && !isTemplate(p.policy) && p.policy !== policy) continue;
                // Files are listed in no rule order: the one placed first in
                // the running rules is the one that matched.
                const at = typeof r?.index === 'number' ? r.index : Number.POSITIVE_INFINITY;
                if (!first || at < first.at) first = { src: { kind: g.immutable ? 'override' : 'mine', file: String(g.group_id), label: String(g.label || g.group_id), raw }, at };
                break;
            }
        }
    }
    if (!first) return { kind: 'sub' };
    if (!Array.isArray(runningRules) || !Number.isInteger(first.at) || !annotationsAgree(groups, runningRules)) return { kind: 'unknown' };
    const sameValue = tests[0];
    const matching = (/** @type {unknown} */ raw) => {
        if (typeof raw !== 'string') return false;
        const parsed = parseRuleLine(raw);
        return ruleType(parsed.type) === ruleType(keyword) && sameValue(parsed.value)
            && (!policy || parsed.policy === policy || isTemplate(parsed.policy));
    };
    // Stale annotations cannot grant edit access to an unrelated runtime row.
    if (!matching(runningRules[first.at])) return { kind: 'unknown' };
    // The controller's rule view omits options such as no-resolve. It cannot
    // confirm that a staged row with those options is the one currently active.
    if (parseRuleLine(String(runningRules[first.at])).extra.length) return { kind: 'unknown' };
    const firstMatch = runningRules.findIndex(matching);
    // A connection reports no matched row index or no-resolve option. Equal
    // CIDR tuples can skip different rows, so they cannot grant edit access.
    if (ruleType(keyword) === 'ipcidr' && runningRules.filter(matching).length > 1) return { kind: 'unknown' };
    return firstMatch === first.at ? first.src : { kind: 'sub' };
}

/** Network identity for valid CIDRs; malformed/unsupported forms stay unequal.
 * IPv6 address validation and compression use the platform URL parser.
 * @param {string} value @returns {string | null}
 */
function cidrNetwork(value) {
    const match = /^([^/]+)\/(0|[1-9]\d*)$/.exec(value);
    if (!match) return null;
    const [, address, length] = match;
    const prefix = Number(length);
    const ipv6 = address.includes(':');
    const width = ipv6 ? 16 : 8;
    if (prefix > (ipv6 ? 128 : 32)) return null;
    let words;
    if (ipv6) {
        if (!/^[0-9a-f:.]+$/i.test(address)) return null;
        let normalized;
        try { normalized = new URL(`http://[${address}]/`).hostname.slice(1, -1); }
        catch { return null; }
        const halves = normalized.split('::');
        const left = halves[0] ? halves[0].split(':') : [];
        const right = halves.length === 2 && halves[1] ? halves[1].split(':') : [];
        const missing = 8 - left.length - right.length;
        if (missing < 0) return null;
        const chunks = halves.length === 2 ? [...left, ...Array(missing).fill('0'), ...right] : left;
        if (chunks.length !== 8) return null;
        words = chunks.map((chunk) => parseInt(chunk, 16));
    } else {
        if (!/^(?:0|[1-9]\d{0,2})(?:\.(?:0|[1-9]\d{0,2})){3}$/.test(address)) return null;
        words = address.split('.').map(Number);
        if (words.some((word) => word > 255)) return null;
    }
    const network = words.map((word, index) => {
        const kept = Math.max(0, Math.min(width, prefix - index * width));
        const unit = 2 ** (width - kept);
        return Math.floor(word / unit) * unit;
    });
    return `${width}:${prefix}:${network.join(':')}`;
}

/** Parse a logical payload's immediate child rules in saved or core display form.
 * @param {string} type @param {string} value @returns {{type: string, value: string}[]|null}
 */
function logicalChildren(type, value) {
    const text = value.trim();
    if (!text.startsWith('(') || !text.endsWith(')')) return null;
    let inner = text.slice(1, -1).trim();
    if (type === 'NOT' && inner.startsWith('!')) inner = inner.slice(1).trim();
    /** @type {{type: string, value: string}[]} */
    const children = [];
    while (inner) {
        if (!inner.startsWith('(')) return null;
        let depth = 0;
        let end = -1;
        for (let index = 0; index < inner.length; index++) {
            if (inner[index] === '(') depth++;
            else if (inner[index] === ')' && --depth === 0) { end = index; break; }
        }
        if (end < 0) return null;
        const child = inner.slice(1, end);
        const comma = child.indexOf(',');
        if (comma < 1) return null;
        children.push({ type: ruleKeyword(child.slice(0, comma).trim()), value: child.slice(comma + 1).trim() });
        inner = inner.slice(end + 1).trim();
        if (!inner) break;
        const operator = type === 'AND' ? '&&' : type === 'OR' ? '||' : '';
        if (type === 'NOT') return null;
        if (inner.startsWith(',')) inner = inner.slice(1).trim();
        else if (operator && inner.startsWith(operator)) inner = inner.slice(operator.length).trim();
        else return null;
        if (!inner) return null;
    }
    return children.length && (type !== 'NOT' || children.length === 1) ? children : null;
}

/** @param {string} type @param {string} a @param {string} b @param {number} [depth] @returns {boolean} */
function sameRuleValue(type, a, b, depth = 0) {
    if (['AND', 'OR', 'NOT'].includes(type) && a !== b) {
        if (depth >= 32) return false;
        const left = logicalChildren(type, a);
        const right = logicalChildren(type, b);
        return left !== null && right !== null && left.length === right.length && left.every((part, index) =>
            ruleType(part.type) === ruleType(right[index].type)
            && sameRuleValue(part.type, part.value, right[index].value, depth + 1));
    }
    if (ruleType(type) === 'ipcidr' && a !== b) {
        const network = cidrNetwork(a);
        return network !== null && network === cidrNetwork(b);
    }
    return ['DOMAIN', 'DOMAIN-SUFFIX', 'DOMAIN-KEYWORD', 'GEOIP'].includes(type)
        ? a.toLowerCase() === b.toLowerCase() : a === b;
}

/** Reject the whole attribution snapshot when any enabled annotation is stale.
 * @param {any[]} groups @param {unknown[]} runningRules
 */
function annotationsAgree(groups, runningRules) {
    return groups.filter((g) => g && g.enabled !== false).every((group) => (group.rules || []).every((/** @type {any} */ rule) => {
        if (!Number.isInteger(rule?.index) || rule.index < 0 || typeof rule.raw !== 'string') return false;
        const raw = runningRules[rule.index];
        if (typeof raw !== 'string') return false;
        const a = parseRuleLine(rule.raw);
        const b = parseRuleLine(raw);
        return ruleType(a.type) === ruleType(b.type) && sameRuleValue(a.type, a.value, b.value)
            && (a.policy === b.policy || isTemplate(a.policy)) && a.extra.join(',') === b.extra.join(',');
    }));
}

/** The staged file can differ from a config the core rejected: check its live order.
 * @param {unknown[]} saved @param {any[]} live
 */
export function runningRulesAgree(saved, live) {
    return Array.isArray(saved) && Array.isArray(live) && saved.length === live.length && saved.every((raw, i) => {
        if (typeof raw !== 'string' || !live[i]) return false;
        const parsed = parseRuleLine(raw);
        const actual = live[i];
        const livePolicy = String(actual.proxy ?? '');
        return ruleType(parsed.type) === ruleType(ruleKeyword(actual.type)) && sameRuleValue(parsed.type, parsed.value, String(actual.payload ?? ''))
            && (parsed.policy === livePolicy || (isTemplate(parsed.policy) && livePolicy !== '' && !isTemplate(livePolicy)));
    });
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
        const suffix = parts.slice(-2).join('.');
        const uncertainCountryBoundary = parts.at(-1)?.length === 2
            && !SECOND_LEVEL.has(parts.at(-2) || '') && !SHARED_SUFFIXES.has(suffix);
        if (isPublicSuffix(parts) || underDeepShared(host) || uncertainCountryBoundary) {
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
    'readthedocs.io', 'readthedocs-hosted.com', 'wixsite.com', 'is-a.dev',
]);

/**
 * Clouds whose tenants sit at varying depths (`bucket.s3.amazonaws.com`,
 * `x.s3.us-east-1.amazonaws.com`): where one tenant's site ends is unknown
 * without the whole public suffix list, so only the exact host is offered.
 */
const DEEP_SHARED = ['amazonaws.com', 'googleusercontent.com', 'storage.googleapis.com', 'azureedge.net',
    'core.windows.net', 'cloudapp.azure.com', 'digitaloceanspaces.com', 'aliyuncs.com', 'myqcloud.com', 'run.app', 'notion.site', 'on.aws'];

/** @param {string} host */
function underDeepShared(host) {
    // US locality names (`k12.ca.us`, `ci.city.ny.us`) nest at varying depths too.
    return DEEP_SHARED.some((d) => host === d || host.endsWith(`.${d}`)) || /(^|\.)[a-z]{2}\.us$/.test(host);
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

/**
 * The rule file parsed as a mapping, or null (no YAML parser, not a mapping).
 * @param {string} content
 * @returns {Record<string, any> | null}
 */
function loadDoc(content) {
    if (typeof jsyaml === 'undefined') return null;
    try {
        const doc = loadPrismYaml(content);
        if (doc == null) return {};
        return isYamlCollection(doc) && !Array.isArray(doc) ? /** @type {Record<string, any>} */ (doc) : null;
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
            if (JSON.stringify(loadPrismYaml(text)) === JSON.stringify(doc)) return text;
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
 * @param {'$prepend'|'$override'} [operator]
 */
function prependText(content, rule, operator = '$prepend') {
    const newline = content.includes('\r\n') ? '\r\n' : '\n';
    const lines = content.split(/\r?\n/);
    const keyPattern = operator === '$override'
        ? /^(\s+)\$override:\s*(\[\])?\s*(#.*)?$/
        : /^(\s+)\$prepend:\s*(\[\])?\s*(#.*)?$/;
    const keys = lines.flatMap((l, i) => (keyPattern.test(l) ? [i] : []));
    if (keys.length !== 1) return null;
    const match = /** @type {RegExpExecArray} */ (keyPattern.exec(lines[keys[0]]));
    if (match[2]) {
        lines[keys[0]] = `${match[1]}${operator}:${match[3] ? ` ${match[3]}` : ''}`;
        lines.splice(keys[0] + 1, 0, `${match[1]}  - ${itemText(rule)}`);
        return lines.join(newline);
    }
    for (let i = keys[0] + 1; i < lines.length; i++) {
        if (/^\s*(?:#.*)?$/.test(lines[i])) continue;
        const m = ITEM_LINE.exec(lines[i]);
        if (!m) {
            lines.splice(i, 0, `${match[1]}  - ${itemText(rule)}`);
            return lines.join(newline);
        }
        lines.splice(i, 0, `${m[1]}${itemText(rule)}`);
        return lines.join(newline);
    }
    lines.splice(keys[0] + 1, 0, `${match[1]}  - ${itemText(rule)}`);
    return lines.join(newline);
}

/** Keep the comments of a plain block list while moving it behind the new rule.
 * @param {string} content @param {string} rule
 */
function prependPlainText(content, rule) {
    const newline = content.includes('\r\n') ? '\r\n' : '\n';
    const lines = content.split(/\r?\n/);
    const keyPattern = /^((?:rules|'rules'|"rules")):\s*(\[\])?\s*(#.*)?$/;
    const start = lines.findIndex((line) => keyPattern.test(line));
    if (start < 0) return null;
    const key = /** @type {RegExpExecArray} */ (keyPattern.exec(lines[start]));
    if (key[2]) {
        lines[start] = `${key[1]}:${key[3] ? ` ${key[3]}` : ''}`;
        return lines.slice(0, start + 1).concat([`  - ${itemText(rule)}`], lines.slice(start + 1)).join(newline);
    }
    let end = start + 1;
    while (end < lines.length && !/^(?:[\p{L}_$][^:]*:|---|\.\.\.)/u.test(lines[end])) end++;
    const block = lines.slice(start + 1, end);
    const first = block.find((line) => /^\s*-\s/.test(line));
    if (!first) return null;
    const indent = first.match(/^\s*/)?.[0] || '';
    return lines.slice(0, start + 1).concat(
        [`${indent}- ${itemText(rule)}`],
        block,
        lines.slice(end),
    ).join(newline);
}

/** Add the first prepend list to a block mapping or an empty rules value.
 * @param {string} content @param {string} rule
 */
function insertPrependText(content, rule) {
    const newline = content.includes('\r\n') ? '\r\n' : '\n';
    const lines = content.split(/\r?\n/);
    const key = /^((?:rules|'rules'|"rules")):[ \t]*(?:\[\]|null|~)?[ \t]*(#.*)?$/;
    const indexes = lines.flatMap((line, index) => key.test(line) ? [index] : []);
    if (indexes.length !== 1) return null;
    const start = indexes[0];
    const match = /** @type {RegExpExecArray} */ (key.exec(lines[start]));
    let indent = '  ';
    for (let index = start + 1; index < lines.length; index++) {
        if (!lines[index].trim() || lines[index].trimStart().startsWith('#')) continue;
        const child = /^( +)\S/.exec(lines[index]);
        if (child) indent = child[1];
        break;
    }
    lines[start] = `${match[1]}:${match[2] ? ` ${match[2]}` : ''}`;
    lines.splice(start + 1, 0, `${indent}$prepend:`, `${indent}  - ${itemText(rule)}`);
    return lines.join(newline);
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
    if (content.split(/\r?\n/).every((line) => !line.trim() || line.trim().startsWith('#'))) {
        return content + (content && !content.endsWith('\n') ? '\n' : '') + dumpDoc({ rules: { $prepend: [rule] } });
    }
    const rules = doc.rules;
    if (rules != null && !isYamlCollection(rules)) return null;
    if (Array.isArray(rules)) {
        // A plain sequence replaces profile rules; keep that behavior and order.
        doc.rules = [rule, ...rules];
    } else if (rules && typeof rules === 'object') {
        if (hasOwn(rules, '$override')) {
            if (!Array.isArray(rules.$override)) return null;
            if (rules.$override[0] === rule) return content;
            doc.rules = { ...rules, $override: [rule, ...rules.$override] };
            return keptOrDumped(prependText(content, rule, '$override'), doc);
        }
        if (rules.$prepend != null && !Array.isArray(rules.$prepend)) return null;
        /** @type {unknown[]} */
        const before = Array.isArray(rules.$prepend) ? rules.$prepend : [];
        if (before[0] === rule) return content;
        doc.rules = hasOwn(rules, '$prepend') ? { ...rules, $prepend: [rule, ...before] }
            : { $prepend: [rule], ...rules };
    } else {
        doc.rules = { $prepend: [rule] };
    }
    const targeted = Array.isArray(rules) ? prependPlainText(content, rule) : prependText(content, rule);
    return keptOrDumped(targeted ?? insertPrependText(content, rule), doc);
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

/** The unique saved source row, including its unresolved policy if templated.
 * @param {string} content @param {string} raw @returns {string|null}
 */
function sourceRuleText(content, raw) {
    const rules = loadDoc(content)?.rules;
    const lists = Array.isArray(rules) ? [rules] : ['$prepend', '$append', '$override'].map((key) => rules?.[key]).filter(Array.isArray);
    const wanted = parseRuleLine(raw);
    /** @type {string[]} */
    const matches = [];
    for (const list of lists) for (const row of list) {
        if (typeof row !== 'string') continue;
        const parsed = parseRuleLine(row);
        if (row.trim() === raw.trim() || (norm(parsed.type) === norm(wanted.type)
            && sameRuleValue(parsed.type, parsed.value, wanted.value) && isTemplate(parsed.policy))) matches.push(row);
    }
    return matches.length === 1 ? matches[0] : null;
}

/** Text alone cannot locate a resolved template beside an identical literal.
 * @param {string} content @param {string} raw
 */
const sourceRuleIsUnique = (content, raw) => sourceRuleText(content, raw) !== null;

/** Match a saved source row to its compiled representation, resolving only policy templates.
 * @param {string} source @param {unknown} compiled
 */
function compiledRuleAgrees(source, compiled) {
    if (typeof compiled !== 'string') return false;
    const expected = parseRuleLine(source);
    const actual = parseRuleLine(compiled);
    return ruleType(expected.type) === ruleType(actual.type)
        && sameRuleValue(expected.type, expected.value, actual.value)
        && expected.extra.join(',') === actual.extra.join(',')
        && (expected.policy === actual.policy || (isTemplate(expected.policy) && actual.policy !== '' && !isTemplate(actual.policy)));
}

/** An equivalent sibling cannot be evidence for this newly saved source row.
 * @param {string} content @param {unknown} compiled
 */
function compiledSourceIsUnique(content, compiled) {
    const rules = loadDoc(content)?.rules;
    const lists = Array.isArray(rules) ? [rules] : ['$prepend', '$append', '$override'].map((key) => rules?.[key]).filter(Array.isArray);
    let matches = 0;
    for (const list of lists) for (const row of list) {
        if (typeof row === 'string' && compiledRuleAgrees(row, compiled)) matches++;
        if (matches > 1) return false;
    }
    return matches === 1;
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
    // Only the rule lists: `$filter`, `$remove` and `$transform` are operators
    // on the profile's rules, not rules of this file.
    const keys = ['$prepend', '$append', '$override'].filter((key) => Array.isArray(rules?.[key]));
    /** @type {any[][]} */
    const lists = Array.isArray(rules) ? [rules]
        : rules && typeof rules === 'object' ? keys.map((key) => rules[key]) : [];
    const [hit] = findRuleIn(lists.map((list) => list.map(String)), oldRaw);
    if (!hit) return undefined;
    const oldValue = String(lists[hit.list][hit.i]);
    // The line keeps its `{{proxy}}`-style template when the edit left the
    // policy as shown (the running config shows it resolved to a group).
    const was = parseRuleLine(oldValue);
    const asked = parseRuleLine(newRaw);
    if (isTemplate(was.policy) && !isTemplate(asked.policy) && asked.policy === parseRuleLine(oldRaw).policy && oldValue.trim() !== oldRaw.trim()) {
        newRaw = buildRuleLine(asked.type, asked.value, was.policy, asked.extra);
    }
    const replacement = [...lists[hit.list]];
    replacement[hit.i] = newRaw;
    if (Array.isArray(rules)) doc.rules = replacement;
    else doc.rules = { ...rules, [keys[hit.list]]: replacement };
    // Edit that one line in place; with duplicates, the one that gives this document.
    const newline = content.includes('\r\n') ? '\r\n' : '\n';
    const lines = content.split(/\r?\n/);
    // A unique textual item is safe to try once. With aliases, duplicate
    // operators or repeated text, use the parsed edit rather than repeatedly
    // parsing the whole document to guess which occurrence was selected.
    let candidate = -1;
    for (let i = 0; i < lines.length; i++) {
        if (itemValue(lines[i]) !== oldValue) continue;
        if (candidate >= 0) return dumpDoc(doc);
        candidate = i;
    }
    if (candidate >= 0) {
        const m = /** @type {RegExpExecArray} */ (ITEM_LINE.exec(lines[candidate]));
        const next = [...lines];
        next[candidate] = `${m[1]}${itemText(newRaw)}${m[3] || ''}`;
        const text = next.join(newline);
        if (keptOrDumped(text, doc) === text) return text;
    }
    return dumpDoc(doc);
}

/**
 * Put `rule` first in the "My rules" file (made when missing), then apply.
 * @param {string} rule
 * @param {() => Promise<boolean>} [canWrite] checked in the queue before the file command
 * @returns {Promise<any>} the apply result
 */
export function addToMyRules(rule, canWrite = async () => true) {
    return queueRuleWrite(async () => {
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
            if (!(await canWrite())) throw new Error(t('connRuleGone'));
            await invoke(COMMANDS.RULE_UPDATE, { filename: existing.filename, content: next, expectedContent: content });
            return applySaved(rule, existing.filename, next, 0);
        }
        if (!(await canWrite())) throw new Error(t('connRuleGone'));
        const filename = myRulesFileName(t('connRuleMyRules'));
        const content = `rules:\n  $prepend:\n    - ${JSON.stringify(rule)}\n`;
        await invoke(COMMANDS.RULE_CREATE, { name: filename, content });
        return applySaved(rule, filename, content, 0);
    });
}

/**
 * Apply after the file was written: a failed apply leaves the rule saved, so
 * it reports "not running yet" (restart notice) rather than an error the
 * dialog would offer to retry.
 * @returns {Promise<any>}
 * @param {string} rule
 * @param {string} filename
 * @param {string} sourceContent
 * @param {number|null} [sourceIndex] known source position selected by Add or Edit
 */
async function applySaved(rule, filename, sourceContent, sourceIndex = null) {
    let result;
    try {
        result = await prism.rebuildWithOverrides();
    } catch (e) {
        rulesLogger.warn('[conn-rule] apply failed', e);
        return { hot_reload_success: false, hot_reload_error: String(/** @type {any} */ (e)?.message ?? e) };
    }
    if ((result?.status?.hot_reload_success ?? result?.hot_reload_success) !== true && result?.core_reload_confirmed !== true) return result;
    try {
        const snapshot = await prism.listRuleSnapshot(filename);
        const groups = Array.isArray(snapshot?.groups) ? snapshot.groups : [];
        const group = groups.find((/** @type {any} */ entry) => entry?.group_id === filename && entry.enabled !== false);
        const sourceRule = sourceRuleText(sourceContent, rule);
        if (snapshot?.annotationsConfirmed === true && snapshot.sourceFile === filename && snapshot.sourceContent === sourceContent
            && runningRulesAgree(snapshot.rules, snapshot.activeRules) && annotationsAgree(groups, snapshot.rules)
            && ((sourceRule !== null && (group?.rules || []).some((/** @type {any} */ row) => compiledRuleAgrees(sourceRule, row.raw)
                && compiledSourceIsUnique(sourceContent, row.raw) && Number.isInteger(row.index)
                && compiledRuleAgrees(sourceRule, snapshot.rules[row.index])))
                || (sourceIndex !== null && sourcePositionAgrees(sourceContent, rule, group?.rules, snapshot.rules, sourceIndex)))) return result;
    } catch (error) { rulesLogger.warn('[conn-rule] could not confirm added rule', error); }
    const dnsWarning = result?.core_reload_confirmed === true && result?.runtime_restore_success === false
        ? `\n${t('dnsRestoreFailed')}` : '';
    return { ...result, notApplied: t('connRuleActivationUnconfirmed') + dnsWarning };
}

/** A known edited/inserted position remains attributable beside duplicate text.
 * Confirm the entire source group's ordering before using that position.
 * @param {string} content @param {string} rule @param {any} annotations @param {unknown[]} runtime @param {number} sourceIndex
 */
function sourcePositionAgrees(content, rule, annotations, runtime, sourceIndex) {
    const rules = loadDoc(content)?.rules;
    if (!rules || typeof rules !== 'object' || !Array.isArray(annotations)) return false;
    const source = Array.isArray(rules) ? rules : Array.isArray(rules.$override) ? rules.$override
        : [...(Array.isArray(rules.$prepend) ? rules.$prepend : []), ...(Array.isArray(rules.$append) ? rules.$append : [])];
    if (typeof source[sourceIndex] !== 'string' || !compiledRuleAgrees(source[sourceIndex], rule) || source.length !== annotations.length) return false;
    const positions = annotations.slice().sort((a, b) => a.index - b.index);
    return source.every((/** @type {unknown} */ raw, /** @type {number} */ index) => {
        const row = positions[index];
        return typeof raw === 'string' && Number.isInteger(row?.index) && row.index >= 0
            && (index === 0 || positions[index - 1].index < row.index)
            && compiledRuleAgrees(raw, row.raw) && compiledRuleAgrees(raw, runtime[row.index]);
    });
}

/** @param {string} content @param {string} raw @returns {number|null} */
function sourcePosition(content, raw) {
    const rules = loadDoc(content)?.rules;
    const lists = Array.isArray(rules) ? [rules] : ['$prepend', '$append', '$override'].map((key) => rules?.[key]).filter(Array.isArray);
    const [hit] = findRuleIn(lists.map((list) => list.map(String)), raw);
    return hit ? lists.slice(0, hit.list).reduce((count, list) => count + list.length, 0) + hit.i : null;
}

/**
 * Replace one line of a library file, then apply.
 * @param {string} file @param {string} oldRaw @param {string} newRaw
 * @param {() => void} [onWritten] the file now holds `newRaw` (called before the apply)
 * @param {string} [openedContent] version from when the editor selected this row
 * @param {() => Promise<boolean>} [canWrite] selected core/rule still owns this edit
 * @param {number} [expectedRulesRevision] checked with the write under the backend config lock
 * @returns {Promise<any>} the apply result
 */
export function replaceInFile(file, oldRaw, newRaw, onWritten = () => {}, openedContent = undefined, canWrite = async () => true, expectedRulesRevision = undefined) {
    return queueRuleWrite(async () => {
        const content = /** @type {string} */ (await invoke(COMMANDS.RULE_READ, { filename: file }));
        // Identical text in a newly inserted row is not the selected row.
        // Without a persistent row id, any file change requires reopening.
        if (openedContent !== undefined && content !== openedContent) {
            throw new Error('RULE_FILE_CHANGED: The rule file changed. Reopen it and retry your edit.');
        }
        if (openedContent !== undefined && !sourceRuleIsUnique(content, oldRaw)) throw new Error(t('connRuleGone'));
        const editedPosition = sourcePosition(content, oldRaw);
        const next = replaceRule(content, oldRaw, newRaw);
        // A file that does not parse is left as it is for repair: rebuilding it
        // from its text could drop its other keys or move its other rules.
        if (next === null) throw new Error(t('notifRulesParseFailed'));
        if (!next) throw new Error(t('connRuleGone'));
        if (!(await canWrite())) throw new Error(t('connRuleGone'));
        await invoke(COMMANDS.RULE_UPDATE, { filename: file, content: next, expectedContent: content, expectedRulesRevision });
        onWritten();
        // Apply builds on the running config, which still holds the old line:
        // rebuild from the profile so it goes, and run the overrides again.
        // A failed rebuild is not papered over with an apply (the old line
        // would keep matching): the file is saved, the next restart rebuilds.
        return applySaved(newRaw, file, next, editedPosition);
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
    if (ok === false) {
        if (result?.core_reload_confirmed === true && result?.runtime_restore_success === false) {
            showNotification(dict().rulesLoadedDnsRestoreFailed || 'Rules are running, but DNS restoration failed. Check DNS settings and retry.', 'warning');
            return;
        }
        const error = result?.hot_reload_error ?? result?.status?.hot_reload_error;
        showNotification(error ? `${t('ruleLibrarySavedApplyFailed')}: ${String(error)}` : t('requireRestart'), 'warning');
    } else showNotification(t(okKey), 'success');
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
    const grouped = src.kind === 'mine' || src.kind === 'override';
    const keyword = grouped ? parseRuleLine(src.raw).type : ruleKeyword(conn?.rule);
    const value = grouped ? parseRuleLine(src.raw).value : String(conn?.rulePayload || '');
    const typeText = keyword === 'MATCH' ? t('connRuleMatchAll') : ruleTypeLabel(keyword, tr);
    // The library could not be read: where the rule comes from is not known.
    const from = grouped ? t('connRuleFromGroup', { name: src.label }) : src.kind === 'sub' ? t('connRuleFromSub') : '';
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
            ${!addOptions(conn).length ? '' : `<button type="button" class="btn-ghost conn-rule-btn" data-conn-rule="add">${escapeHtml(t('connRuleAdd'))}</button>`}
        </div>
    </section>`;
}

/** Bumped by every rule card shown: a dialog still loading for an older one does not open. */
let cardSeq = 0;
/** @type {(() => void)|null} Only the latest card can own a visible Edit action. */
let invalidateVisibleEdit = null;
Bus.on(Events.CONNECTIONS_PAGE_LEFT, () => { cardSeq++; });
for (const event of [Events.CONFIG_UPDATED, Events.CORE_RESTARTED, Events.DIAGNOSTICS_INVALIDATED]) {
    Bus.on(event, () => invalidateVisibleEdit?.());
}

/**
 * Fill the rule card into `slot` and wire its buttons. `beforeDialog` runs
 * before a dialog opens (the detail panel closes so the dialog gets focus).
 * @param {HTMLElement} slot
 * @param {any} conn
 * @param {() => void} [beforeDialog]
 * @param {boolean} [historical] the connection predates the current live rule snapshot
 * @param {() => boolean} [isConnectionLive] backed by polling, independent of the detail modal
 */
export async function mountRuleCard(slot, conn, beforeDialog = () => {}, historical = false, isConnectionLive = () => true) {
    invalidateVisibleEdit = null;
    const seq = ++cardSeq;
    const mountedGeneration = coreReplacements();
    const version = currentRulesVersion();
    const started = typeof conn?.start === 'number' ? conn.start : Date.parse(conn?.start ?? conn?.metadata?.start ?? '');
    const predatesRules = version.changedAt > 0 && (!Number.isFinite(started) || started <= version.changedAt);
    const sourceStillCurrent = () => isConnectionLive() && slot.dataset.historical !== 'true'
        && coreReplacements() === mountedGeneration && currentRulesVersion().revision === version.revision;
    /** @type {any[]} */
    let groups = [];
    /** @type {unknown[] | null} */
    let runningRules = null;
    /** @type {number|null} */
    let snapshotRevision = null;
    let listed = true;
    try {
        if (historical || predatesRules || !sourceStillCurrent()) {
            // eslint-disable-next-line no-unsanitized/property -- ruleCardHtml escapes every value
            slot.innerHTML = ruleCardHtml(conn, { kind: 'unknown' }); // nosemgrep: js-innerhtml-assignment — escaped
            slot.querySelector('[data-conn-rule="add"]')?.addEventListener('click', () => { beforeDialog(); void openAddDialog(conn, seq); });
            return;
        }
        const generation = coreReplacements();
        const snapshot = await prism.listRuleSnapshot();
        groups = Array.isArray(snapshot?.groups) ? snapshot.groups : [];
        if (snapshot?.annotationsConfirmed === true && Number.isSafeInteger(snapshot.rulesRevision)
            && generation === coreReplacements() && runningRulesAgree(snapshot?.rules, snapshot?.activeRules)) {
            runningRules = snapshot.rules;
            snapshotRevision = snapshot.rulesRevision;
        }
        else listed = false;
    } catch (e) {
        // Not "from the subscription": one of the user's own rules would
        // then offer only Add, writing a second rule beside it.
        listed = false;
        rulesLogger.warn('[conn-rule] list failed', e);
    }
    if (!slot.isConnected) return;
    /** @type {RuleSource} */
    let src = slot.dataset.historical === 'true' ? /** @type {RuleSource} */ ({ kind: 'unknown' }) : findRuleSource(conn, groups, runningRules);
    if (!listed && src.kind === 'sub') src = { kind: 'unknown' };
    if (src.kind === 'mine') {
        try {
            const generation = coreReplacements();
            const snapshot = await prism.listRuleSnapshot(src.file);
            /** @type {RuleSource} */
            const confirmed = snapshot?.annotationsConfirmed === true && snapshot.rulesRevision === snapshotRevision
                && runningRulesAgree(snapshot?.rules, snapshot?.activeRules)
                ? findRuleSource(conn, snapshot.groups, snapshot.rules) : { kind: 'unknown' };
            src = confirmed.kind === 'mine' && generation === coreReplacements()
                && confirmed.file === src.file && confirmed.raw === src.raw
                && snapshot.sourceFile === src.file && typeof snapshot.sourceContent === 'string'
                && sourceRuleIsUnique(snapshot.sourceContent, src.raw)
                && Number.isSafeInteger(snapshot.rulesRevision)
                ? { ...confirmed, openedContent: snapshot.sourceContent, rulesRevision: snapshot.rulesRevision } : { kind: 'unknown' };
        } catch (error) {
            rulesLogger.warn('[conn-rule] source snapshot failed', error);
            src = { kind: 'unknown' };
        }
    }
    if (!slot.isConnected || seq !== cardSeq) return;
    if (!sourceStillCurrent()) src = { kind: 'unknown' };
    // eslint-disable-next-line no-unsanitized/property -- every value escaped in ruleCardHtml
    slot.innerHTML = ruleCardHtml(conn, src); // nosemgrep: js-innerhtml-assignment — escaped
    slot.querySelector('[data-conn-rule="add"]')?.addEventListener('click', () => { beforeDialog(); void openAddDialog(conn, seq); });
    const removeStaleEdit = () => {
        if (sourceStillCurrent()) return;
        const edit = slot.querySelector('[data-conn-rule="edit"]');
        if (edit?.contains(document.activeElement)) {
            const next = slot.querySelector('[data-conn-rule="add"]') || document.getElementById('detail-dismiss-btn');
            if (next instanceof HTMLElement) next.focus();
        }
        edit?.remove();
    };
    if (src.kind === 'mine') invalidateVisibleEdit = removeStaleEdit;
    if (src.kind === 'mine') slot.querySelector('[data-conn-rule="edit"]')?.addEventListener('click', () => {
        if (!sourceStillCurrent()) {
            removeStaleEdit();
            showNotification(t('connRuleGone'), 'warning');
            return;
        }
        beforeDialog();
        void openEditDialog(conn, src, seq, sourceStillCurrent);
    });
}

/** String rules cannot encode a policy containing column or line separators.
 * @param {string} type @param {string} value @param {string} policy
 */
export function buildConnectionRule(type, value, policy) {
    if (/[,\r\n]/.test(policy)) throw new Error(`${t('connRulePolicy')}: ${t('connRuleValueComma')}`);
    return buildRuleLine(type, value, policy);
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

/** @param {HTMLElement} area */
function ruleDialogIsOpen(area) {
    const backdrop = area.closest('#modal-bg');
    return area.isConnected && !!backdrop && !backdrop.classList.contains('opacity-0') && !backdrop.classList.contains('hidden');
}

/** @param {any} conn @param {number} [seq] the card it was opened from */
async function openAddDialog(conn, seq = cardSeq) {
    const page = document.querySelector('[data-page="connections"]');
    const tr = dict();
    const opts = addOptions(conn);
    if (!opts.length) return;
    const policies = await loadPolicyNames(() => fetchProxyGroups());
    // Another connection's detail was opened meanwhile: this dialog is not wanted.
    if (seq !== cardSeq || page?.classList.contains('hidden')) return;
    const current = rulePolicy(conn);
    // Archived connections can name a policy from an old profile. Only the
    // current groups and built-in policies are offered for a new rule.
    const policyOptions = policies.map((p) => ({ value: p, label: p }));
    const policySelected = policies.includes(current) ? current : (policies[0] || 'DIRECT');
    // Site suffix suggestions are not a complete public suffix database. The
    // default must target only the selected host; broader matching is opt-in.
    const exactHost = opts.findIndex((option) => option.type === 'DOMAIN');
    const defaultPick = exactHost >= 0 ? exactHost : 0;
    const cards = opts.map((o, i) => `<button type="button" role="radio" aria-checked="${i === defaultPick}" tabindex="${i === defaultPick ? 0 : -1}" class="choice-card" data-i="${i}">
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
    let cancelled = false;
    await showModal(t('connRuleAdd'), '', '', true, html, (area, close) => {
        const isOpen = () => !cancelled && seq === cardSeq && ruleDialogIsOpen(area);
        restoreDropdown(area, 'conn-rule-policy', policyOptions, policySelected);
        area.querySelectorAll('.choice-card-desc').forEach((el, i) => { if (opts[i]) el.textContent = opts[i].value; });
        dd = initCustomDropdown({ wrapId: 'conn-rule-policy-wrap', triggerId: 'conn-rule-policy-trigger', menuId: 'conn-rule-policy-menu', labelId: 'conn-rule-policy-label', selectId: 'conn-rule-policy-select' });
        restoreChoiceRoles(area);
        const showError = errorSlot(area);
        let pick = defaultPick;
        const choices = /** @type {HTMLButtonElement[]} */ ([...area.querySelectorAll('.choice-card')]);
        const choose = (/** @type {HTMLButtonElement} */ card) => {
            if (card.disabled) return;
            pick = Number(card.dataset.i) || 0;
            choices.forEach((o) => {
                const on = o === card;
                o.setAttribute('aria-checked', String(on));
                o.setAttribute('tabindex', on ? '0' : '-1');
            });
        };
        choices.forEach((card, index) => {
            card.addEventListener('click', () => choose(card));
            card.addEventListener('keydown', (event) => {
                if (event.defaultPrevented || card.disabled) return;
                const forward = event.key === 'ArrowDown' || event.key === 'ArrowRight';
                if (!forward && event.key !== 'ArrowUp' && event.key !== 'ArrowLeft') return;
                event.preventDefault();
                const next = choices[(index + (forward ? 1 : -1) + choices.length) % choices.length];
                choose(next);
                next.focus();
            });
        });
        area.querySelector('[data-act="cancel"]')?.addEventListener('click', () => { cancelled = true; close(null); });
        const ok = /** @type {HTMLButtonElement | null} */ (area.querySelector('[data-act="ok"]'));
        ok?.addEventListener('click', async () => {
            const o = opts[pick];
            const policy = dd?.getValue() || policySelected;
            ok.disabled = true;
            showError('');
            const locked = [...area.querySelectorAll('input, select, button')]
                .filter((element) => element !== ok && element.getAttribute('data-act') !== 'cancel')
                .map((element) => {
                    const control = /** @type {HTMLInputElement|HTMLSelectElement|HTMLButtonElement} */ (element);
                    const disabled = control.disabled;
                    control.disabled = true;
                    return { control, disabled };
                });
            const policyWrap = /** @type {HTMLElement|null} */ (area.querySelector('#conn-rule-policy-wrap'));
            const wasInert = policyWrap?.inert ?? false;
            if (policyWrap) policyWrap.inert = true;
            try {
                const rule = buildConnectionRule(o.type, o.value, policy);
                const result = await addToMyRules(rule, async () => {
                    if (!isOpen()) return false;
                    const latestPolicies = await loadPolicyNames(() => fetchProxyGroups());
                    return isOpen() && latestPolicies.includes(policy);
                });
                close(null);
                noticeAfterApply(result, 'connRuleAdded');
            } catch (e) {
                showError(String(/** @type {any} */ (e)?.message ?? e));
                ok.disabled = false;
                locked.forEach(({ control, disabled }) => { control.disabled = disabled; });
                if (policyWrap) policyWrap.inert = wasInert;
            }
        });
    }, () => { cancelled = true; return true; });
    dd?.dispose();
}

/**
 * @param {any} conn
 * @param {{ kind: 'mine', file: string, label: string, raw: string, openedContent?: string, rulesRevision?: number }} src
 * @param {number} [seq] the card it was opened from
 * @param {() => boolean} [isLive] false once the detail becomes historical
 */
async function openEditDialog(conn, src, seq = cardSeq, isLive = () => true) {
    const page = document.querySelector('[data-page="connections"]');
    const tr = dict();
    const parsed = parseRuleLine(src.raw);
    const openedContent = src.openedContent;
    let dialogOpen = () => true;
    if (typeof openedContent !== 'string') {
        showNotification(t('connRuleGone'), 'error');
        return;
    }
    const canWrite = async () => {
        if (!dialogOpen() || !isLive() || seq !== cardSeq) return false;
        const snapshot = await prism.listRuleSnapshot(src.file);
        if (!dialogOpen() || !isLive() || seq !== cardSeq || snapshot.annotationsConfirmed !== true
            || snapshot.rulesRevision !== src.rulesRevision
            || snapshot.sourceContent !== openedContent || !runningRulesAgree(snapshot.rules, snapshot.activeRules)) return false;
        const current = findRuleSource(conn, snapshot.groups, snapshot.rules);
        if (current.kind !== 'mine' || current.file !== src.file || current.raw !== src.raw) return false;
        try {
            const active = await getConnections();
            return dialogOpen() && isLive() && seq === cardSeq && !!conn?.id
                && !!active?.connections?.some((/** @type {any} */ live) => live.id === conn.id);
        } catch { return false; }
    };
    const policies = await loadPolicyNames(() => fetchProxyGroups());
    if (seq !== cardSeq || !isLive() || page?.classList.contains('hidden')) return;
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
    let cancelled = false;
    await showModal(t('connRuleEdit'), '', '', true, html, (area, close) => {
        dialogOpen = () => !cancelled && ruleDialogIsOpen(area);
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
        area.querySelector('[data-act="cancel"]')?.addEventListener('click', () => { cancelled = true; close(null); });
        const ok = /** @type {HTMLButtonElement | null} */ (area.querySelector('[data-act="ok"]'));
        ok?.addEventListener('click', async () => {
            const type = typeDd?.getValue() || parsed.type;
            const value = valueInput.value.trim();
            if (!value && !isPolicyOnlyType(type)) { showError(tr.ruleLibraryInsertNeedValue || 'Enter what to match'); valueInput.focus(); return; }
            const policy = polDd?.getValue() || parsed.policy;
            if (/[,\r\n]/.test(policy)) {
                showError(`${t('connRulePolicy')}: ${t('connRuleValueComma')}`);
                return;
            }
            const next = buildRuleLine(type, isPolicyOnlyType(type) ? '' : value, policy, parsed.extra);
            // A comma in the value would move the policy into another field
            // ("example.org,Proxy" + REJECT reads as Proxy).
            const back = parseRuleLine(next);
            if (back.policy !== policy || (!isPolicyOnlyType(type) && back.value !== value)) {
                showError(tr.connRuleValueComma || "What to match can't contain a comma");
                valueInput.focus();
                return;
            }
            ok.disabled = true;
            showError('');
            const locked = [...area.querySelectorAll('input, select, button')]
                .filter((element) => element !== ok && element.getAttribute('data-act') !== 'cancel')
                .map((element) => {
                    const control = /** @type {HTMLInputElement|HTMLSelectElement|HTMLButtonElement} */ (element);
                    const disabled = control.disabled;
                    control.disabled = true;
                    return { control, disabled };
                });
            const dropdowns = [...area.querySelectorAll('#conn-rule-type-wrap, #conn-rule-epolicy-wrap')];
            dropdowns.forEach((element) => { /** @type {HTMLElement} */ (element).inert = true; });
            try {
                const result = await replaceInFile(src.file, baseline, next, () => { baseline = next; }, openedContent, canWrite, src.rulesRevision);
                close(null);
                noticeAfterApply(result, 'connRuleSaved');
            } catch (e) {
                showError(String(/** @type {any} */ (e)?.message ?? e));
                ok.disabled = false;
                locked.forEach(({ control, disabled }) => { control.disabled = disabled; });
                dropdowns.forEach((element) => { /** @type {HTMLElement} */ (element).inert = false; });
            }
        });
    }, () => { cancelled = true; return true; });
    dds.forEach((d) => d.dispose());
}
