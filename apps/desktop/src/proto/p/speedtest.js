// #2314 真实下载测速（只对单个节点手动测一次）。?proto=speedtest-menu / speedtest-result
import { $, $$, html, icon, ICONS, wait } from './_kit.js';
import { proxiesReady } from './_proxies.js';

export async function post() {
  await proxiesReady();
  const card = $$('#proxies-list > [data-name]').find((c) => c.dataset.name.includes('香港 03'));
  if (window.__PROTO__.endsWith('menu')) {
    // 悬停节点卡时，在「重新测试」旁边多一个「测下载速度」按钮
    const retest = card.querySelector('.node-retest-btn');
    const btn = html(`<button type="button" class="node-retest-btn proto-speed-btn" title="测试下载速度">${icon(ICONS.download, 'w-3 h-3')}</button>`);
    retest.before(btn);
    card.classList.add('proto-force-hover');
    const r = btn.getBoundingClientRect();
    document.body.appendChild(html(`<div class="proto-tip" style="top:${r.bottom + 8}px;left:${r.left + r.width / 2}px">测试下载速度<span>约使用 25 MB 流量</span></div>`));
    return;
  }
  const panel = html(`<div class="proto-dialog fixed inset-0 z-[var(--z-modal)] flex items-center justify-center bg-[var(--zephyr-bg-overlay)] backdrop-blur-md">
    <div class="glass-card p-6 proto-st-card">
      <div class="flex items-center justify-between">
        <h3 class="dialog-title">下载测速</h3>
        <button class="text-[var(--text-secondary)]" aria-label="关闭">${icon(ICONS.x, 'w-5 h-5')}</button>
      </div>
      <p class="text-xs text-[var(--text-secondary)] mt-1"><span class="proto-flag">🇭🇰</span> 香港 03 IPLC</p>
      <div class="proto-st-big"><span class="proto-st-num">38.6</span><span class="proto-st-unit">MB/s</span></div>
      <div class="proto-st-bar"><span style="width:100%"></span></div>
      <div class="proto-st-grid">
        <div><p>延迟</p><b>21 ms</b></div>
        <div><p>用时</p><b>0.7 s</b></div>
        <div><p>流量</p><b>25 MB</b></div>
      </div>
      <div class="flex justify-end gap-2 mt-5"><button class="btn-ghost">关闭</button><button class="btn-primary">重新测试</button></div>
    </div>
  </div>`);
  document.body.appendChild(panel);
}
