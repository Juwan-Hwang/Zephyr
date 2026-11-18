// #2439 / #673 变体 B：三个开关压成顶部一条，订阅切换放在流量卡左上角
import { $, html } from './_kit.js';
import { homeParts, subSelect } from './_home.js';

export async function post() {
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
