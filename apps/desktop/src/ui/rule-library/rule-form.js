// @ts-check
/**
 * Shared pieces of the rule forms (Insert Rule dialog, inline rule editor):
 * rule types, policy list, the custom dropdown markup and rule-line helpers.
 *
 * @module ui/rule-library/rule-form
 */

import { escapeHtml, escapeAttr } from '../../utils/sanitize.js';

/** Rule types offered in the forms, most common first. Value = Clash keyword, key = i18n key. */
export const RULE_TYPES = Object.freeze([
    { value: 'DOMAIN-SUFFIX', key: 'ruleTypeDomainSuffix', fallback: 'Domain suffix' },
    { value: 'DOMAIN', key: 'ruleTypeDomain', fallback: 'Domain' },
    { value: 'DOMAIN-KEYWORD', key: 'ruleTypeDomainKeyword', fallback: 'Domain keyword' },
    { value: 'GEOSITE', key: 'ruleTypeGeosite', fallback: 'GeoSite' },
    { value: 'IP-CIDR', key: 'ruleTypeIpCidr', fallback: 'IP range' },
    { value: 'IP-CIDR6', key: 'ruleTypeIpCidr6', fallback: 'IPv6 range' },
    { value: 'GEOIP', key: 'ruleTypeGeoip', fallback: 'GeoIP' },
    { value: 'PROCESS-NAME', key: 'ruleTypeProcessName', fallback: 'Process name' },
    { value: 'DST-PORT', key: 'ruleTypeDstPort', fallback: 'Destination port' },
    { value: 'SRC-IP-CIDR', key: 'ruleTypeSrcIpCidr', fallback: 'Source IP range' },
    { value: 'RULE-SET', key: 'ruleTypeRuleSet', fallback: 'Rule set' },
    { value: 'MATCH', key: 'ruleTypeMatch', fallback: 'Fallback (MATCH)' },
]);

/** Built-in policies that are always valid targets. */
export const BUILTIN_POLICIES = Object.freeze(['DIRECT', 'REJECT']);

/**
 * Display label for a rule type.
 * @param {string} value
 * @param {Record<string, string>} t
 * @returns {string}
 */
export function ruleTypeLabel(value, t) {
    const def = RULE_TYPES.find((r) => r.value === value);
    if (!def) return value;
    return t[def.key] || def.fallback;
}

/**
 * Split a rule line into its parts. `extra` keeps trailing options such as `no-resolve`.
 * @param {string} line
 * @returns {{type: string, value: string, policy: string, extra: string[]}}
 */
export function parseRuleLine(line) {
    const parts = String(line || '').split(',').map((s) => s.trim());
    const type = (parts[0] || '').toUpperCase();
    if (type === 'MATCH') {
        return { type, value: '', policy: parts[1] || '', extra: parts.slice(2) };
    }
    return { type, value: parts[1] || '', policy: parts[2] || '', extra: parts.slice(3) };
}

/**
 * Join form fields back into one rule line.
 * @param {string} type
 * @param {string} value
 * @param {string} policy
 * @param {string[]} [extra]
 * @returns {string}
 */
export function buildRuleLine(type, value, policy, extra = []) {
    const tail = extra.filter(Boolean);
    const head = type === 'MATCH' ? [type, policy] : [type, value.trim(), policy];
    return [...head, ...tail].join(',');
}

/**
 * True when the text already is a whole rule line ("DOMAIN-SUFFIX,example.com,Proxy")
 * or a JSON rule object — the form then uses it as is.
 * @param {string} text
 * @returns {boolean}
 */
export function looksLikeFullRule(text) {
    const s = String(text || '').trim();
    if (s.startsWith('{')) return true;
    return /^[A-Z][A-Z0-9-]*,[^,]*,[^,]+/.test(s) || /^MATCH,[^,]+$/i.test(s);
}

/**
 * Policy targets: proxy groups in config order, then DIRECT / REJECT.
 * @param {() => Promise<{orderedGroupNames?: string[], groups?: string[]}|null>} fetchGroups
 * @returns {Promise<string[]>}
 */
export async function loadPolicyNames(fetchGroups) {
    /** @type {string[]} */
    let names = [];
    try {
        const r = await fetchGroups();
        names = (r?.orderedGroupNames?.length ? r.orderedGroupNames : r?.groups) || [];
    } catch {
        names = [];
    }
    const out = names.filter((n) => n && n !== 'GLOBAL' && !BUILTIN_POLICIES.includes(n));
    return [...new Set(out), ...BUILTIN_POLICIES];
}

/**
 * Markup for a custom dropdown (mirrors a hidden native <select>, see ui/dropdown.js).
 * Only elements whose `id` survives the modal sanitizer carry ids (div / button / select).
 * @param {string} id - prefix; produces `${id}-wrap/-trigger/-label/-menu/-select`
 * @param {{value: string, label: string}[]} options
 * @param {string} selected
 * @param {string} [ariaLabel]
 * @returns {string}
 */
export function dropdownHtml(id, options, selected, ariaLabel = '') {
    const current = options.find((o) => o.value === selected) || options[0] || { value: '', label: '' };
    const items = options.map((o) => `<button type="button" data-value="${escapeAttr(o.value)}" data-label="${escapeAttr(o.label)}" class="dropdown-option w-full text-start px-3 py-2 rounded-[var(--radius-dropdown-option)] text-xs text-[var(--text-secondary)] hover:bg-[var(--zephyr-bg-muted)] transition-colors ${o.value === current.value ? 'active' : ''}">${escapeHtml(o.label)}</button>`).join('');
    const opts = options.map((o) => `<option value="${escapeAttr(o.value)}" ${o.value === current.value ? 'selected' : ''}>${escapeHtml(o.label)}</option>`).join('');
    return `
        <div id="${id}-wrap" class="relative rl-form-dropdown">
            <button id="${id}-trigger" type="button" class="select-common rl-form-select w-full flex items-center justify-between" aria-label="${escapeAttr(ariaLabel)}" aria-haspopup="listbox">
                <div id="${id}-label" class="truncate min-w-0 text-start">${escapeHtml(current.label)}</div>
                <svg class="w-3.5 h-3.5 shrink-0 text-[var(--text-muted)] transition-transform duration-[var(--zephyr-time-micro)] dropdown-arrow" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="m6 9 6 6 6-6"></path></svg>
            </button>
            <div id="${id}-menu" class="hidden absolute inset-inline-0 top-[calc(100%+6px)] rounded-lg border border-[var(--zephyr-border-default)] bg-[var(--zephyr-bg-elevated)] shadow-2xl z-30">
                <div class="menu-scroll rl-form-menu custom-scrollbar">${items}</div>
            </div>
            <select id="${id}-select" class="hidden">${opts}</select>
        </div>
    `;
}
