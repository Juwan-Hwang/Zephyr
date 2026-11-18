// #2439 双击流量图进入连接页 → 改成看得见的「查看连接」入口
// ?proto=chartlink-link（链接版）/ chartlink-hover（双击版：悬停提示）
import { $, html, icon, ICONS, until } from './_kit.js';

export async function post() {
  const hero = await until(() => $('#home-hero'));
  if (window.__PROTO__.endsWith('hover')) {
    hero.classList.add('proto-hero-hover');
    hero.appendChild(html(`<div class="proto-dbl-hint">双击查看连接</div>`));
    return;
  }
  hero.appendChild(html(`<button type="button" class="proto-hero-link">12 个连接${icon(ICONS.arrowRight, 'w-3.5 h-3.5')}</button>`));
}
