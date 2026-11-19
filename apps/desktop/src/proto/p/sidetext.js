// 定稿侧栏（第二版）：只有文字，没有图标，也没有收起按钮。
// 用户否决了「图标 + 文字」的侧栏和靠加一个图标按钮切换展开 / 收起的做法。
// 中文导航名都是两个字，纯文字侧栏和原来 80 px 的图标栏一样窄，所以 720 宽也不用收起：
// 一种状态、所有窗口尺寸通用。宽度跟着最长的名字走（英文等更长的语言会自动变宽）。
import { $, $$, until } from './_kit.js';

const SHORT = { home: '首页', proxies: '节点', subscriptions: '订阅', connections: '连接', 'rule-library': '规则', logs: '日志', settings: '设置', overrides: '覆写', plugins: '插件', console: '控制台' };

function placeIndicator() {
  const active = $('#sidebar-nav .nav-btn.is-active');
  const ind = $('#sidebar-nav .nav-indicator');
  if (!ind || !active) return;
  ind.classList.add('no-anim');
  ind.style.width = `${active.offsetWidth}px`;
  ind.style.height = `${active.offsetHeight}px`;
  ind.style.transform = `translate(${active.offsetLeft}px, ${active.offsetTop}px)`;
  void ind.offsetWidth;
  ind.classList.remove('no-anim');
}

export async function post() {
  await until(() => $$('#sidebar-nav [data-nav]').length > 3);
  document.documentElement.classList.add('proto-side-text');
  for (const b of $$('#sidebar-nav [data-nav]')) {
    if (b.querySelector('.st-label')) continue;
    const sr = b.querySelector('.sr-only');
    const s = document.createElement('span');
    s.className = 'st-label';
    s.textContent = SHORT[b.dataset.nav] || sr?.textContent || '';
    b.appendChild(s);
    // 名字已经写在按钮上，悬停提示就多余了
    b.removeAttribute('title');
  }
  await document.fonts?.ready;
  placeIndicator();
  setTimeout(placeIndicator, 400);
  new ResizeObserver(placeIndicator).observe($('#sidebar-nav'));
}
