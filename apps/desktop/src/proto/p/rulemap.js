// #555 更直观地看规则和代理组的对应关系：代理组旁边显示「命中的规则」
import { $, html, icon, ICONS } from './_kit.js';
import { proxiesReady } from './_proxies.js';

const RULES = [
  ['DOMAIN-SUFFIX', 'github.com', 128],
  ['DOMAIN-SUFFIX', 'google.com', 96],
  ['DOMAIN-KEYWORD', 'telegram', 41],
  ['GEOSITE', 'gfw', 37],
  ['RULE-SET', 'proxy-list（3,182 条）', 22],
  ['MATCH', '其余所有流量', 9],
];

export async function post() {
  await proxiesReady();
  const label = $('#proxy-group-label');
  const anchor = label.closest('button') || label.parentElement;
  const pill = html(`<button type="button" class="proto-pill is-accent proto-rule-pill">${icon(ICONS.route, 'w-3 h-3')}6 条规则</button>`);
  anchor.after(pill);
  if (window.__PROTO__.endsWith('pill')) return;
  const r = pill.getBoundingClientRect();
  const pop = html(`<div class="proto-rule-pop" style="top:${r.bottom + 8}px;left:${r.left - 8}px">
    <div class="proto-rule-head"><p>走「🚀 节点选择」的规则</p><span>今天命中</span></div>
    ${RULES.map(([t, p, n]) => `<div class="proto-rule-row"><span class="proto-rule-type">${t}</span><span class="proto-rule-payload">${p}</span><span class="proto-rule-hits">${n}</span></div>`).join('')}
    <div class="proto-rule-foot">在规则库中查看${icon(ICONS.arrowRight, 'w-3 h-3')}</div>
  </div>`);
  document.body.appendChild(pop);
}
