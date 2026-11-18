// 定稿：简洁首页。
// 开关条（系统代理 / 模式 / TUN）→ 流量卡 → 「当前节点」条。
// - 流量卡只留两个大数字和图；「总流量」并进大数字下面的一行小字，
//   「活动连接」变成右上角的「12 个连接」入口，「节点延迟」挖到节点条里，底部统计行去掉。
// - 流量卡中间的节点胶囊去掉，当前节点和延迟较低的节点一起放进最下面的节点条，
//   像音乐 App 的「正在播放」。打开「显示 IP 地址」后，IP 和地区出现在节点名下面。
// 钩子：window.__F__ = { ip: true, subOpen: true, nodeOpen: true }
import { $, html, icon, ICONS } from './_kit.js';
import { homeParts, subSelect } from './_home.js';

export const NODE = { flag: '🇭🇰', name: '香港 03 IPLC', ms: 21, ip: '203.0.113.48', region: '香港' };
export const ALTS = [
  ['🇹🇼', '台湾 01', 38],
  ['🇯🇵', '东京 01', 46],
  ['🇸🇬', '新加坡 01', 63],
  ['🇰🇷', '首尔 01', 71],
  ['🇯🇵', '大阪 02', 74],
];
const CHEV = '<path d="m6 9 6 6 6-6"/>';
const ARROW = '<path d="m9 18 6-6-6-6"/>';

export function stateSub(on) { return on ? '已打开' : '已关闭'; }

export function nodeSub(F) {
  const ms = `<span class="fh-ms"><i class="fh-dot"></i>${NODE.ms} ms</span>`;
  return F.ip
    ? `${ms}<span class="fh-sep">·</span><span class="fh-ip">IP ${NODE.ip}</span><span class="fh-sep">·</span><span>${NODE.region}</span>`
    : `${ms}<span class="fh-sep">·</span><span>节点选择</span>`;
}

export async function post(F = window.__F__ || {}) {
  const { page, hero, sysCard, grid } = await homeParts();
  page.classList.add('fh-page');
  const sysSwitch = sysCard.querySelector('.ios-switch');
  const sysIcon = sysCard.querySelector('svg').cloneNode(true);
  const modeSel = $('#mode-selector-container');
  const tunSwitch = $('#tun-proxy-toggle').closest('.ios-switch');
  const tunIcon = $('#home-tun-title').parentElement.querySelector('svg').cloneNode(true);
  const sysOn = $('#sys-proxy-toggle').checked;
  const strip = html(`<div class="glass-card proto-strip fh-strip relative z-10 shrink-0">
    <div class="proto-strip-cell" data-c="sys"><span class="proto-strip-icon is-accent"></span><div class="min-w-0 flex-1"><p class="proto-strip-title">系统代理</p><p class="proto-strip-sub">${stateSub(sysOn)}</p></div></div>
    <div class="proto-strip-sep"></div>
    <div class="proto-strip-cell is-mode" data-c="mode"></div>
    <div class="proto-strip-sep"></div>
    <div class="proto-strip-cell" data-c="tun"><span class="proto-strip-icon is-rose"></span><div class="min-w-0 flex-1"><p class="proto-strip-title">TUN</p><p class="proto-strip-sub">已关闭</p></div></div>
  </div>`);
  sysIcon.setAttribute('class', 'w-4 h-4');
  tunIcon.setAttribute('class', 'w-4 h-4');
  strip.querySelector('[data-c=sys] .proto-strip-icon').append(sysIcon);
  strip.querySelector('[data-c=sys]').append(sysSwitch);
  strip.querySelector('[data-c=mode]').append(modeSel);
  strip.querySelector('[data-c=tun] .proto-strip-icon').append(tunIcon);
  strip.querySelector('[data-c=tun]').append(tunSwitch);
  sysSwitch.classList.remove('switch-lg');
  sysCard.style.display = 'none';
  grid.style.display = 'none';
  page.prepend(strip);
  page.append(hero);
  hero.classList.add('fh-hero');

  // 流量卡顶部：左边订阅切换，右边「12 个连接」
  const head = html(`<div class="fh-hero-head"></div>`);
  const sub = subSelect({ open: !!F.subOpen, width: 150, compact: true });
  head.append(sub);
  head.append(html(`<button type="button" class="fh-conn-link" aria-label="查看 12 个连接"><b>12</b> 个连接${icon(ARROW, 'w-3.5 h-3.5')}</button>`));
  hero.querySelector('.home-hero-body').prepend(head);
  $('#node-wheel-container').style.display = 'none';

  // 大数字下面加一行累计；标题改短
  const totals = [$('#home-stat-down')?.textContent?.trim() || '334.34 MB', $('#home-stat-up')?.textContent?.trim() || '5.30 MB'];
  hero.querySelectorAll('.home-speed').forEach((s, i) => {
    const lab = s.querySelector('.home-speed-label > span:last-child');
    if (lab) lab.textContent = i ? '上传' : '下载';
    s.append(html(`<span class="fh-total">${i ? '已上传' : '已下载'} ${totals[i]}</span>`));
  });
  $('#home-stats').style.display = 'none';

  // 当前节点条
  const bar = html(`<div class="glass-card fh-node relative z-10 shrink-0">
    <button type="button" class="fh-current" aria-haspopup="listbox" aria-label="当前节点：${NODE.name}，点按以切换">
      <span class="fh-flag">${NODE.flag}</span>
      <span class="min-w-0 flex-1"><span class="fh-name">${NODE.name}</span><span class="fh-sub">${nodeSub(F)}</span></span>
      ${icon(CHEV, 'w-4 h-4 fh-chev')}
    </button>
    <div class="fh-alts" role="group" aria-label="延迟较低">
      <p class="fh-alts-label">延迟较低</p>
      <div class="fh-alts-list">${ALTS.map(([f, n, ms]) => `<button type="button" class="fh-alt" title="切换到 ${n}"><span class="fh-alt-flag">${f}</span><span class="fh-alt-name">${n}</span><span class="fh-alt-ms">${ms} ms</span></button>`).join('')}</div>
    </div>
  </div>`);
  page.append(bar);
  window.dispatchEvent(new Event('resize'));
  return { strip, hero, bar };
}
