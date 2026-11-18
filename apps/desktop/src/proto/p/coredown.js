// #182 #217 #318 #609 内核被其他代理应用关闭后，弹横幅并给出「重新启动」
import { $, html, icon, ICONS, until } from './_kit.js';
import { isConsole, consoleParts } from './_con.js';

export function pre() {
  window.__PROTO_TRAFFIC_ZERO__ = true;
}

export async function post() {
  const con = isConsole() ? await consoleParts() : null;
  if (!con) await until(() => $('#home-hero') || $('[data-page="home"]'));
  if (window.__PROTO__.endsWith('before')) return;
  const page = $('[data-page="home"]');
  const banner = html(`<div class="proto-core-banner glass-card relative z-20 shrink-0" role="alert">
    <span class="proto-core-banner-icon">${icon(ICONS.alert, 'w-4 h-4')}</span>
    <div class="min-w-0 flex-1">
      <p class="proto-core-banner-title">内核已停止运行</p>
      <p class="proto-core-banner-desc">可能已被其他代理应用关闭。重新启动之前，你将无法连接网络。</p>
    </div>
    <div class="flex items-center gap-2 shrink-0">
      <button type="button" class="btn-ghost text-xs px-3 py-1.5">关闭系统代理</button>
      <button type="button" class="btn-primary text-xs px-3.5 py-1.5 flex items-center gap-1.5">${icon(ICONS.refresh, 'w-3.5 h-3.5')}重新启动</button>
    </div>
  </div>`);
  if (con) {
    // 控制台首页：横幅放在标题下面、指标条上面，在布局里占位
    con.header.after(banner);
    $('#dz-node-name').textContent = '内核未运行';
    return;
  }
  page.prepend(banner);
  const name = $('#current-node-name');
  if (name) name.textContent = '内核未运行';
}
