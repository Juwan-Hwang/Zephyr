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
import { parseRulesFromYaml, rebuildYamlWithRules } from './rule-library/yaml-utils.js';
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
 *   | { kind: 'set' } | { kind: 'match' } | { kind: 'sub' }} RuleSource
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
    const payload = String(conn?.rulePayload || '').toLowerCase();
    const policy = rulePolicy(conn);
    for (const g of Array.isArray(groups) ? groups : []) {
        if (!g || typeof g !== 'object' || g.immutable || !g.group_id) continue;
        for (const r of g.rules || []) {
            const raw = String(r?.raw ?? r ?? '');
            const p = parseRuleLine(raw);
            if (norm(p.type) !== norm(keyword) || p.value.toLowerCase() !== payload) continue;
            if (policy && p.policy && p.policy !== policy) continue;
            return { kind: 'mine', file: String(g.group_id), label: String(g.label || g.group_id), raw };
        }
    }
    return { kind: 'sub' };
}

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
    if (host && !/^[\d.:]+$/.test(host)) {
        const parts = host.split('.');
        const site = siteLabels(parts);
        out.push({ type: 'DOMAIN-SUFFIX', value: parts.slice(-site).join('.') });
        out.push({ type: 'DOMAIN', value: host });
        if (parts.length >= site && site >= 2) out.push({ type: 'DOMAIN-KEYWORD', value: parts[parts.length - site] });
    }
    const ip = String(meta.destinationIP || '').trim();
    if (ip) out.push(ip.includes(':') ? { type: 'IP-CIDR6', value: `${ip}/128` } : { type: 'IP-CIDR', value: `${ip}/32` });
    const proc = String(meta.process || '').trim();
    if (proc) out.push({ type: 'PROCESS-NAME', value: proc });
    return out;
}

/** Second-level labels used under country codes (`example.co.uk`, `site.com.cn`). */
const SECOND_LEVEL = new Set(['co', 'com', 'net', 'org', 'gov', 'edu', 'ac', 'or', 'ne', 'go', 'gob', 'gouv', 'mil', 'nic', 'ltd', 'plc', 'sch', 'info', 'biz', 'nom']);

/**
 * How many trailing labels make up the site's own domain: two for
 * `api.example.com`, three for `api.example.co.uk`, so a suffix rule never
 * covers a whole country's `co.uk` or `com.cn`.
 * @param {string[]} parts
 * @returns {number}
 */
function siteLabels(parts) {
    const n = parts.length;
    if (n <= 2) return n;
    const tld = parts[n - 1];
    const second = parts[n - 2];
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
 * `content` with its rules in a `$prepend` block, so a rule added there comes
 * before the subscription's. A file in another form keeps its other keys.
 * @param {string} content
 * @returns {string}
 */
function asPrepend(content) {
    if (/^\s*\$prepend\s*:/m.test(content)) return content;
    if (typeof jsyaml !== 'undefined') {
        try {
            const doc = jsyaml.load(content);
            if (doc && typeof doc === 'object' && !Array.isArray(doc)) {
                return jsyaml.dump({ ...doc, rules: { $prepend: [] } }, { lineWidth: -1 });
            }
        } catch { /* fall back below */ }
    }
    if (/^\s*\$append\s*:/m.test(content)) return content.replace(/^(\s*)\$append(\s*:)/m, '$1$$prepend$2');
    return 'rules:\n  $prepend: []\n';
}

/**
 * Put `rule` first in the "My rules" file (made when missing), then apply.
 * @param {string} rule
 * @returns {Promise<any>} the apply result
 */
export function addToMyRules(rule) {
    return serially(async () => {
        const files = /** @type {any[]} */ (await invoke(COMMANDS.RULE_LIST).catch(() => []));
        const existing = findMyRulesFile(files);
        if (existing && !existing.enabled) {
            throw new Error(t('connRuleMyRulesOff', { name: existing.filename.replace(/\.prism\.yaml$/, '') }));
        }
        if (existing) {
            const content = /** @type {string} */ (await invoke(COMMANDS.RULE_READ, { filename: existing.filename }));
            const rules = parseRulesFromYaml(content);
            const next = rebuildYamlWithRules(asPrepend(content), [rule, ...rules.filter((r) => r.trim() !== rule)]);
            await invoke(COMMANDS.RULE_UPDATE, { filename: existing.filename, content: next });
        } else {
            await invoke(COMMANDS.RULE_CREATE, { name: myRulesFileName(t('connRuleMyRules')), content: `rules:\n  $prepend:\n    - ${JSON.stringify(rule)}\n` });
        }
        return prism.apply();
    });
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
        const rules = parseRulesFromYaml(content);
        const i = rules.findIndex((r) => r.trim() === oldRaw.trim());
        if (i < 0) throw new Error(t('connRuleGone'));
        rules[i] = newRaw;
        await invoke(COMMANDS.RULE_UPDATE, { filename: file, content: rebuildYamlWithRules(content, rules) });
        onWritten();
        return prism.apply();
    });
}

/**
 * The notice after a saved rule: success, or that the core has not taken it yet.
 * @param {any} result the apply result
 * @param {string} okKey
 */
function noticeAfterApply(result, okKey) {
    if (result?.hot_reload_success === false) showNotification(t('requireRestart'), 'warning');
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
    const from = src.kind === 'mine' ? t('connRuleFromGroup', { name: src.label }) : t('connRuleFromSub');
    const note = src.kind === 'set' ? t('connRuleSetNote') : src.kind === 'match' ? t('connRuleMatchNote') : src.kind === 'sub' ? t('connRuleSubNote') : '';
    return `<section class="conn-rule-card" aria-labelledby="conn-rule-title">
        <div class="conn-rule-head"><h4 id="conn-rule-title">${escapeHtml(t('connRuleTitle'))}</h4><span class="conn-rule-src">${escapeHtml(from)}</span></div>
        <div class="conn-rule-line">
            <span class="conn-rule-type">${escapeHtml(typeText)}</span>
            ${value && keyword !== 'MATCH' ? `<code class="conn-rule-payload">${escapeHtml(value)}</code>` : ''}
            <span class="conn-rule-arrow" aria-hidden="true">→</span><span class="conn-rule-group">${escapeHtml(rulePolicy(conn) || '-')}</span>
        </div>
        ${note ? `<p class="conn-rule-note">${escapeHtml(note)}</p>` : ''}
        <div class="conn-rule-actions">
            ${src.kind === 'mine' ? `<button type="button" class="btn-ghost conn-rule-btn" data-conn-rule="edit">${escapeHtml(t('connRuleEdit'))}</button>` : ''}
            <button type="button" class="btn-ghost conn-rule-btn" data-conn-rule="add">${escapeHtml(t('connRuleAdd'))}</button>
        </div>
    </section>`;
}

/**
 * Fill the rule card into `slot` and wire its buttons. `beforeDialog` runs
 * before a dialog opens (the detail panel closes so the dialog gets focus).
 * @param {HTMLElement} slot
 * @param {any} conn
 * @param {() => void} [beforeDialog]
 */
export async function mountRuleCard(slot, conn, beforeDialog = () => {}) {
    /** @type {any[]} */
    let groups = [];
    try { groups = /** @type {any[]} */ (await prism.listRules()) || []; } catch (e) { rulesLogger.debug('[conn-rule] list failed', e); }
    if (!slot.isConnected) return;
    const src = findRuleSource(conn, groups);
    // eslint-disable-next-line no-unsanitized/property -- every value escaped in ruleCardHtml
    slot.innerHTML = ruleCardHtml(conn, src); // nosemgrep: js-innerhtml-assignment — escaped
    slot.querySelector('[data-conn-rule="add"]')?.addEventListener('click', () => { beforeDialog(); void openAddDialog(conn); });
    if (src.kind === 'mine') slot.querySelector('[data-conn-rule="edit"]')?.addEventListener('click', () => { beforeDialog(); void openEditDialog(conn, src); });
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

/** @param {any} conn */
async function openAddDialog(conn) {
    const tr = dict();
    const opts = addOptions(conn);
    if (!opts.length) return;
    const policies = await loadPolicyNames(() => fetchProxyGroups());
    const current = rulePolicy(conn);
    const policyOptions = policies.map((p) => ({ value: p, label: p }));
    const cards = opts.map((o, i) => `<button type="button" role="radio" aria-checked="${i === 0}" tabindex="${i === 0 ? 0 : -1}" class="choice-card" data-i="${i}">
        <span class="choice-card-title">${escapeHtml(ruleTypeLabel(o.type, tr))}</span><span class="choice-card-desc font-mono">${escapeHtml(o.value)}</span></button>`).join('');
    const html = `<div class="space-y-4 conn-rule-form">
        <p class="text-xs text-[var(--text-secondary)] truncate">${escapeHtml(String(conn?.metadata?.host || conn?.metadata?.destinationIP || ''))}</p>
        <div class="space-y-2"><span class="rl-field-label" data-label="conn-rule-how">${escapeHtml(t('connRuleHow'))}</span>
            <div class="choice-grid" role="radiogroup" aria-labelledby="conn-rule-how" style="--choice-cols:${Math.min(3, opts.length)}">${cards}</div></div>
        <div class="space-y-2"><span class="rl-field-label">${escapeHtml(t('connRulePolicy'))}</span>${dropdownHtml('conn-rule-policy', policyOptions, policies.includes(current) ? current : (policies[0] || 'DIRECT'), t('connRulePolicy'))}</div>
        <p class="text-2xs text-[var(--text-muted)]">${escapeHtml(t('connRuleAddFoot', { name: t('connRuleMyRules') }))}</p>
        <div class="conn-rule-error hidden text-xs text-[var(--zephyr-color-danger)]" aria-live="polite"></div>
        <div class="flex items-center justify-end gap-2 pt-1">
            <button type="button" class="btn-ghost" data-act="cancel">${escapeHtml(t('cancel'))}</button>
            <button type="button" class="btn-primary" data-act="ok">${escapeHtml(t('connRuleAddConfirm'))}</button>
        </div></div>`;
    /** @type {any} */
    let dd = null;
    await showModal(t('connRuleAdd'), '', '', true, html, (area, close) => {
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
 */
async function openEditDialog(_conn, src) {
    const tr = dict();
    const parsed = parseRuleLine(src.raw);
    const policies = await loadPolicyNames(() => fetchProxyGroups());
    if (parsed.policy && !policies.includes(parsed.policy)) policies.unshift(parsed.policy);
    const typeOptions = RULE_TYPES.map((r) => ({ value: r.value, label: ruleTypeLabel(r.value, tr) }));
    // A type the form does not offer (PROCESS-PATH, DOMAIN-REGEX…) stays as it is.
    if (parsed.type && !typeOptions.some((o) => o.value === parsed.type)) {
        typeOptions.unshift({ value: parsed.type, label: ruleTypeLabel(parsed.type, tr) });
    }
    const html = `<div class="space-y-4 conn-rule-form">
        <p class="text-xs text-[var(--text-secondary)] truncate">${escapeHtml(t('connRuleFromGroup', { name: src.label }))}</p>
        <div class="rl-insert-grid">
            <div class="space-y-2 min-w-0"><span class="rl-field-label">${escapeHtml(tr.ruleLibraryRuleType || 'Rule type')}</span>${dropdownHtml('conn-rule-type', typeOptions, parsed.type, tr.ruleLibraryRuleType || 'Rule type')}</div>
            <div class="space-y-2 min-w-0"><label class="rl-field-label" for="conn-rule-value">${escapeHtml(tr.ruleLibraryRuleMatch || 'Match')}</label>
                <input id="conn-rule-value" type="text" class="form-control form-control-lg form-control-mono" value="${escapeHtml(parsed.value)}" spellcheck="false" /></div>
        </div>
        <div class="space-y-2"><span class="rl-field-label">${escapeHtml(t('connRulePolicy'))}</span>${dropdownHtml('conn-rule-epolicy', policies.map((p) => ({ value: p, label: p })), parsed.policy || policies[0] || 'DIRECT', t('connRulePolicy'))}</div>
        <div class="conn-rule-error hidden text-xs text-[var(--zephyr-color-danger)]" aria-live="polite"></div>
        <div class="flex items-center justify-end gap-2 pt-1">
            <button type="button" class="btn-ghost" data-act="cancel">${escapeHtml(t('cancel'))}</button>
            <button type="button" class="btn-primary" data-act="ok">${escapeHtml(t('save'))}</button>
        </div></div>`;
    /** @type {any[]} */
    const dds = [];
    await showModal(t('connRuleEdit'), '', '', true, html, (area, close) => {
        const valueInput = /** @type {HTMLInputElement} */ (area.querySelector('#conn-rule-value'));
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
