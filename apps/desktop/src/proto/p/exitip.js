// #321 #673 首页显示出口 IP 和地区（点一下才查）。?proto=exitip-idle / exitip-done
import { $, html, icon, ICONS, until } from './_kit.js';

export async function post() {
  const name = await until(() => $('#current-node-name'));
  const done = window.__PROTO__.endsWith('done');
  const pill = html(done
    ? `<button type="button" class="proto-exit-pill is-done"><span class="proto-exit-flag">🇭🇰</span><span class="proto-exit-ip">203.0.113.48</span><span class="proto-exit-sep"></span><span>香港 · HKT</span>${icon(ICONS.refresh, 'w-3 h-3 proto-exit-refresh')}</button>`
    : `<button type="button" class="proto-exit-pill">${icon(ICONS.globe, 'w-3.5 h-3.5')}<span>查询出口 IP</span></button>`);
  // 在首页 hero 的正常布局里占一行：放在节点胶囊下面、速度读数上面，
  // 速度读数在剩下的空间里居中，被往下推，不靠 z-index 盖上去。
  const speeds = $('.home-hero-speeds');
  speeds.before(pill);
}
