// #2439 侧边栏图标配文字。?proto=sidelabel-under（图标下方小字）/ sidelabel-wide（展开侧边栏）
import { $, $$, until } from './_kit.js';

const SHORT = { home: '首页', proxies: '节点', subscriptions: '订阅', connections: '连接', 'rule-library': '规则', logs: '日志', settings: '设置', overrides: '覆写', plugins: '插件', console: '控制台' };

export async function post() {
  await until(() => $$('#sidebar-nav [data-nav]').length > 3);
  const variant = window.__PROTO__.split('-')[1];
  document.documentElement.classList.add(`proto-side-${variant}`);
  for (const b of $$('#sidebar-nav [data-nav]')) {
    const sr = b.querySelector('.sr-only');
    const label = SHORT[b.dataset.nav] || sr?.textContent || '';
    const s = document.createElement('span');
    s.className = 'proto-nav-label';
    s.textContent = label;
    b.appendChild(s);
  }
  await new Promise((r) => setTimeout(r, 700));
  const active = $('#sidebar-nav .nav-btn.is-active');
  const ind = $('#sidebar-nav .nav-indicator');
  if (ind && active) {
    ind.classList.add('no-anim');
    ind.style.setProperty('transition', 'none', 'important');
    ind.style.setProperty('width', `${active.offsetWidth}px`, 'important');
    ind.style.setProperty('height', `${active.offsetHeight}px`, 'important');
    ind.style.setProperty('transform', `translate(${active.offsetLeft}px, ${active.offsetTop}px)`, 'important');
  }
}
