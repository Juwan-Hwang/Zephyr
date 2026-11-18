// 连接页：点开一个连接，直接编辑它命中的规则，或为它添加规则。
// 上一版「代理组旁边显示命中的规则」（rulemap）已否决，由这个取代。
//
// ?proto=connrule-before        现在的连接详情（改动前）
// ?proto=connrule               命中「我的规则」里的一条：可编辑 + 可添加
// ?proto=connrule-set           命中规则集：只能添加
// ?proto=connrule-match         命中 MATCH：只能添加
// ?proto=connrule-add           为 youtube 连接添加规则
// ?proto=connrule-edit          编辑 anthropic.com 那条规则
//
// 写入方式（按现有架构）：
// - 规则来自规则库文件（*.prism.yaml，activeRules 里 immutable=false 的分组）→ 「编辑规则」
//   用 RULE_READ 读文件、替换那一行、rebuildYamlWithRules 写回（RULE_UPDATE），再 prism.apply()，
//   和规则库里编辑单条规则是同一条路。
// - 规则来自订阅本身 / RULE-SET / MATCH → 不提供编辑，只提供添加。
// - 「添加规则」写进规则库里的「我的规则」文件（没有就建，rules: { $prepend: [...] }），再 prism.apply()。
//   不用 prism.insertRuleStr：它只改当前运行配置，下一次 apply()（切换订阅、更新订阅、改覆写）就没了。
import { $, $$, html, until, wait } from './_kit.js';

const CASES = {
  mine:  { host: 'api.anthropic.com', type: 'DOMAIN-SUFFIX', payload: 'anthropic.com', group: '🤖 AI 服务', src: '来自「我的规则」', editable: true },
  set:   { host: 'www.youtube.com', type: 'RULE-SET', payload: 'google', group: '🚀 节点选择', src: '来自订阅' },
  match: { host: 'www.figma.com', type: 'MATCH', payload: '', group: '🚀 节点选择', src: '来自订阅' },
};
const TYPE_LABEL = { 'DOMAIN-SUFFIX': '域名后缀', DOMAIN: '完整域名', 'DOMAIN-KEYWORD': '域名关键字', 'IP-CIDR': 'IP 段', 'PROCESS-NAME': '进程名', 'RULE-SET': '规则集', MATCH: '其他所有连接' };
const NOTE = {
  set: '规则集中的规则无法单独编辑。如果要更改此连接使用的策略组，可以添加规则。',
  match: '此连接未命中任何规则。如果要更改它使用的策略组，可以添加规则。',
};
const chev = '<svg class="w-3.5 h-3.5 shrink-0 text-[var(--text-muted)]" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="m6 9 6 6 6-6"></path></svg>';
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

async function openConn(host) {
  await until(() => $$('[data-conn-id]').some((r) => r.textContent.includes(host)), 6000);
  const row = $$('[data-conn-id]').find((r) => r.textContent.includes(host));
  row.click();
  await until(() => $('#conn-detail-panel'));
  await wait(350);
  return $('#conn-detail-panel');
}

/** 现有面板里那一行「规则类型 · 内容 · → 链路」（mock 的 rulePayload 都是 host，先纠正成真实样子） */
function ruleLine(panel) {
  return [...panel.querySelectorAll('div.flex.items-center.gap-3.mb-5')][0];
}

function fixBefore(panel, c) {
  const line = ruleLine(panel);
  const spans = line.querySelectorAll('span');
  spans[0].textContent = c.type === 'MATCH' ? 'Match' : c.type;
  if (c.payload) spans[1].textContent = c.payload; else spans[1]?.remove();
}

function ruleCard(c, key) {
  const value = c.type === 'MATCH' ? '' : `<code class="proto-cr-payload">${esc(c.payload)}</code>`;
  return `<section class="proto-cr-card" aria-labelledby="proto-cr-title">
    <div class="proto-cr-head"><h4 id="proto-cr-title">规则</h4><span class="proto-cr-src">${esc(c.src)}</span></div>
    <div class="proto-cr-rule">
      <span class="proto-cr-type">${TYPE_LABEL[c.type]}</span>${value}
      <span class="proto-cr-arrow" aria-hidden="true">→</span><span class="proto-cr-group">${esc(c.group)}</span>
    </div>
    ${c.editable ? '' : `<p class="proto-cr-note">${NOTE[key]}</p>`}
    <div class="proto-cr-actions">
      ${c.editable ? '<button type="button" class="btn-ghost proto-cr-btn" id="proto-cr-edit">编辑规则</button>' : ''}
      <button type="button" class="btn-ghost proto-cr-btn" id="proto-cr-add">添加规则</button>
    </div>
  </section>`;
}

function select(label) {
  return `<button type="button" class="select-common rl-form-select w-full flex items-center justify-between" aria-haspopup="listbox"><div class="truncate min-w-0 text-start">${esc(label)}</div>${chev}</button>`;
}

function shell(title, sub, body, primary) {
  const el = html(`<div class="proto-dialog fixed inset-0 z-[var(--z-modal)] flex items-center justify-center bg-[var(--zephyr-bg-overlay)] backdrop-blur-md">
    <div class="glass-card p-6 border-accent/20 shadow-2xl shadow-accent/10 proto-cr-dialog" role="dialog" aria-modal="true" aria-labelledby="proto-cr-dtitle">
      <h3 class="dialog-title mb-1" id="proto-cr-dtitle">${title}</h3>
      <p class="text-xs text-[var(--text-secondary)] mb-5 truncate">${esc(sub)}</p>
      ${body}
      <div class="flex gap-3 justify-end mt-6"><button class="btn-ghost">取消</button><button class="btn-primary">${primary}</button></div>
    </div></div>`);
  document.body.appendChild(el);
  return el;
}

function addDialog(conn) {
  const host = conn.metadata.host;
  const parts = host.split('.');
  const suffix = parts.slice(-2).join('.');
  const opts = [
    ['DOMAIN-SUFFIX', suffix],
    ['DOMAIN', host],
    ['DOMAIN-KEYWORD', parts.at(-2)],
    ['IP-CIDR', `${conn.metadata.destinationIP}/32`],
    ['PROCESS-NAME', conn.metadata.process],
  ];
  const cards = opts.map(([t, v], i) => `<button type="button" role="radio" aria-checked="${i === 0}" class="choice-card"><span class="choice-card-title">${TYPE_LABEL[t]}</span><span class="choice-card-desc font-mono">${esc(v)}</span></button>`).join('');
  const pos = [
    ['最前面', '推荐', true, ''],
    ['「广告拦截」之后', '', false, ''],
    ['最后', '不会生效', false, 'is-warn'],
  ].map(([l, h, on, cls]) => `<label class="rl-pos-option"><input type="radio" name="proto-cr-pos" ${on ? 'checked' : ''}/><span class="rl-pos-label">${l}</span>${h ? `<span class="rl-pos-hint ${cls}">${h}</span>` : ''}</label>`).join('');
  const body = `<div class="space-y-4">
    <div class="space-y-2"><span class="rl-field-label" id="proto-cr-how">匹配方式</span>
      <div class="choice-grid" role="radiogroup" aria-labelledby="proto-cr-how" style="--choice-cols:3">${cards}</div></div>
    <div class="space-y-2"><span class="rl-field-label">策略组</span>${select('🎯 流媒体')}</div>
    <div class="space-y-2"><span class="rl-field-label">位置</span><div class="proto-cr-pos">${pos}</div></div>
    <p class="proto-cr-foot">规则会添加到「我的规则」。</p>
  </div>`;
  return shell('添加规则', host, body, '添加');
}

function editDialog(c) {
  const body = `<div class="space-y-4">
    <div class="rl-insert-grid">
      <div class="space-y-2 min-w-0"><span class="rl-field-label">类型</span>${select(TYPE_LABEL[c.type])}</div>
      <div class="space-y-2 min-w-0"><label class="rl-field-label" for="proto-cr-val">匹配内容</label><input id="proto-cr-val" type="text" class="form-control form-control-lg form-control-mono" value="${esc(c.payload)}" spellcheck="false"/></div>
    </div>
    <div class="space-y-2"><span class="rl-field-label">策略组</span>${select(c.group)}</div>
  </div>`;
  return shell('编辑规则', c.src, body, '保存');
}

export async function post() {
  const n = window.__PROTO__;
  const key = n.endsWith('-set') ? 'set' : n.endsWith('-match') ? 'match' : n.endsWith('-add') ? 'set' : 'mine';
  const c = CASES[key];
  const panel = await openConn(c.host);
  if (n === 'connrule-before') { fixBefore(panel, c); return; }
  ruleLine(panel).replaceWith(html(ruleCard(c, key)));
  if (n.endsWith('-add')) {
    const conn = { metadata: { host: c.host, destinationIP: '142.250.66.78', process: 'Chrome' } };
    addDialog(conn);
  } else if (n.endsWith('-edit')) {
    editDialog(c);
  }
  await wait(250);
}
