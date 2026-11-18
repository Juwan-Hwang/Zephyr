// #2439 首页显示延迟最低的前几个节点
import { html } from './_kit.js';
import { homeParts } from './_home.js';
import { isConsole, consoleParts, applyConsoleB } from './_con.js';

const TOP = [
  ['🇭🇰', '香港 03 IPLC', 21, true],
  ['🇹🇼', '台湾 01', 38, false],
  ['🇯🇵', '日本 东京 01', 46, false],
  ['🇸🇬', '新加坡 01', 63, false],
];

export async function post() {
  const con = isConsole() ? await consoleParts() : null;
  if (con) await applyConsoleB();
  const strip = html(`<div class="glass-card proto-top relative z-10 shrink-0">
    <div class="proto-top-head"><p class="proto-top-title">最快节点</p><p class="proto-top-sub">🚀 节点选择 · 2 分钟前</p></div>
    <div class="proto-top-list">
      ${TOP.map(([f, n, ms, on]) => `<button type="button" class="proto-top-chip ${on ? 'is-on' : ''}"><span class="proto-top-flag">${f}</span><span class="proto-top-name">${n}</span><span class="proto-top-ms">${ms}<small>ms</small></span></button>`).join('')}
    </div>
  </div>`);
  if (con) {
    // 控制台首页：放在指标条和流量图之间，占一整行
    con.kpis.after(strip);
  } else {
    const { sysCard } = await homeParts();
    sysCard.before(strip);
  }
  window.dispatchEvent(new Event('resize'));
}
