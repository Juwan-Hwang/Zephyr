// #2439 / #673 变体 B：三个开关压成顶部一条，订阅切换放在流量卡左上角
import { $, html } from './_kit.js';
import { homeParts, subSelect } from './_home.js';
import { isConsole, consoleParts } from './_con.js';

export async function post() {
  if (isConsole()) return consoleB();
  const { page, hero, sysCard, grid } = await homeParts();
  const sysSwitch = sysCard.querySelector('.ios-switch');
  const sysIcon = sysCard.querySelector('svg').cloneNode(true);
  const modeSel = $('#mode-selector-container');
  const tunSwitch = $('#tun-proxy-toggle').closest('.ios-switch');
  const tunIcon = $('#home-tun-title').parentElement.querySelector('svg').cloneNode(true);
  const strip = html(`<div class="glass-card proto-strip relative z-10 shrink-0">
    <div class="proto-strip-cell" data-c="sys"><span class="proto-strip-icon is-accent"></span><div class="min-w-0 flex-1"><p class="proto-strip-title">系统代理</p><p class="proto-strip-sub">127.0.0.1:7890</p></div></div>
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
  const sub = subSelect({ open: !!window.__PROTO_OPEN__, width: 150, compact: true });
  sub.classList.add('proto-hero-sub');
  hero.querySelector('.home-hero-body').append(sub);
  window.dispatchEvent(new Event('resize'));
}

// 控制台首页：同样三个开关压成标题下面的一条（用控制台自己的模式分段和开关），
// 「快捷控制」卡去掉；订阅卡从底部挪到右栏「当前节点」下面，订阅名换成下拉切换。
async function consoleB() {
  const { header, quickCard, side, subCard, bottom } = await consoleParts();
  const sysRow = $('#dz-sys-toggle').closest('.dz-quick-row');
  const tunRow = $('#dz-tun-toggle').closest('.dz-quick-row');
  const strip = html(`<div class="glass-card proto-strip relative z-10 shrink-0">
    <div class="proto-strip-cell" data-c="sys"><span class="proto-strip-icon is-accent"></span><div class="min-w-0 flex-1"><p class="proto-strip-title">系统代理</p><p class="proto-strip-sub">127.0.0.1:7890</p></div></div>
    <div class="proto-strip-sep"></div>
    <div class="proto-strip-cell is-mode" data-c="mode"></div>
    <div class="proto-strip-sep"></div>
    <div class="proto-strip-cell" data-c="tun"><span class="proto-strip-icon is-rose"></span><div class="min-w-0 flex-1"><p class="proto-strip-title">TUN</p><p class="proto-strip-sub">已关闭</p></div></div>
  </div>`);
  const ic = (row) => { const s = row.querySelector('.dz-quick-row-label svg').cloneNode(true); s.setAttribute('class', 'w-4 h-4'); return s; };
  strip.querySelector('[data-c=sys] .proto-strip-icon').append(ic(sysRow));
  strip.querySelector('[data-c=tun] .proto-strip-icon').append(ic(tunRow));
  const sysSw = sysRow.querySelector('.ios-switch');
  const tunSw = tunRow.querySelector('.ios-switch');
  sysSw.classList.remove('switch-lg');
  tunSw.classList.remove('switch-lg');
  strip.querySelector('[data-c=sys]').append(sysSw);
  strip.querySelector('[data-c=tun]').append(tunSw);
  const seg = $('#dz-mode-seg');
  seg.classList.add('proto-strip-seg');
  strip.querySelector('[data-c=mode]').append(seg);
  header.after(strip);
  quickCard.style.display = 'none';
  side.append(subCard);
  subCard.style.flex = '1';
  bottom.classList.add('proto-bottom-two');
  const name = $('#dz-sub-name');
  const sel = subSelect({ open: !!window.__PROTO_OPEN__, width: 170, compact: true });
  sel.classList.add('proto-con-sub');
  name.replaceWith(sel);
  window.dispatchEvent(new Event('resize'));
}
