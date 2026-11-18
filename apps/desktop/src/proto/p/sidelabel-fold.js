// 侧栏：展开（图标 + 文字）/ 收起（只有图标），可切换并记住状态。?proto=sidelabel-fold
// 测试钩子：window.__PROTO_SIDE__ = 'collapsed' | 'expanded'（覆盖记住的状态），
//          window.__PROTO_SIDE_OPEN__ = true（窄窗口下展开成浮层）。
import { $, $$, until } from './_kit.js';

const SHORT = { home: '首页', proxies: '节点', subscriptions: '订阅', connections: '连接', 'rule-library': '规则', logs: '日志', settings: '设置', overrides: '覆写', plugins: '插件', console: '控制台' };
const KEY = 'zephyr.sidebar';
/** 窗口比这个窄时默认收起，展开时浮在内容上方，不挤主内容区 */
const NARROW = 860;

const ICON_TOGGLE = `<svg aria-hidden="true" class="icon proto-fold-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="4" width="18" height="16" rx="3"/><path d="M9 4v16"/><path class="proto-fold-chev" d="m15 10-2 2 2 2"/></svg>`;

export async function post() {
  await until(() => $$('#sidebar-nav [data-nav]').length > 3);
  const root = document.documentElement;
  const nav = $('#sidebar-nav');
  root.classList.add('proto-side-fold');

  for (const b of $$('#sidebar-nav [data-nav]')) {
    const sr = b.querySelector('.sr-only');
    if (sr && SHORT[b.dataset.nav]) sr.textContent = SHORT[b.dataset.nav];
    const s = document.createElement('span');
    s.className = 'proto-nav-label';
    s.setAttribute('aria-hidden', 'true');
    s.textContent = SHORT[b.dataset.nav] || sr?.textContent || '';
    b.appendChild(s);
  }

  // 折叠按钮：放在侧栏最底部。带 nav-btn 类，收起时复用现有的侧栏提示（ui/nav-tooltip.js）。
  const t = document.createElement('button');
  t.type = 'button';
  t.id = 'proto-side-toggle';
  t.className = 'nav-btn proto-side-toggle';
  t.setAttribute('aria-controls', 'sidebar-nav');
  t.setAttribute('aria-keyshortcuts', 'Control+B Meta+B');
  t.innerHTML = `${ICON_TOGGLE}<span class="sr-only"></span><span class="proto-nav-label" aria-hidden="true"></span>`;
  nav.appendChild(t);

  const narrow = () => innerWidth < NARROW;
  const saved = () => window.__PROTO_SIDE__ || localStorage.getItem(KEY) || 'expanded';
  let overlay = false;

  const indicator = () => $('#sidebar-nav .nav-indicator');
  // 选中项的高亮块是单独定位的；宽度过渡期间逐帧跟住选中按钮，避免高亮先跳到终点。
  // 只要侧栏宽度还在过渡（transitionrun → transitionend），就逐帧更新高亮块。
  let raf = 0, moving = false;
  nav.addEventListener('transitionrun', (e) => { if (e.target === nav && e.propertyName === 'width') { moving = true; follow(); } });
  const stop = (e) => { if (e.target === nav && e.propertyName === 'width') moving = false; };
  nav.addEventListener('transitionend', stop);
  nav.addEventListener('transitioncancel', stop);
  const place = () => {
    const ind = indicator();
    const active = $('#sidebar-nav .nav-btn.is-active');
    if (!ind || !active) return ind;
    ind.classList.add('no-anim');
    ind.style.width = `${active.offsetWidth}px`;
    ind.style.transform = `translate(${active.offsetLeft}px, ${active.offsetTop}px)`;
    return ind;
  };
  const follow = () => {
    cancelAnimationFrame(raf);
    const step = () => {
      const ind = place();
      if (moving) raf = requestAnimationFrame(step);
      else requestAnimationFrame(() => { place(); ind?.classList.remove('no-anim'); });
    };
    step();
  };

  const apply = (expanded, { animate = true } = {}) => {
    if (!animate) root.classList.add('proto-side-instant');
    root.classList.toggle('proto-side-expanded', expanded);
    root.classList.toggle('proto-side-narrow', narrow());
    root.classList.toggle('proto-side-overlay', expanded && narrow());
    const label = expanded ? '隐藏边栏' : '显示边栏';
    t.setAttribute('aria-expanded', String(expanded));
    t.setAttribute('aria-label', label);
    t.querySelector('.sr-only').textContent = label;
    t.querySelector('.proto-nav-label').textContent = label;
    $('#nav-tooltip')?.classList.remove('is-visible');
    if (!animate) { void nav.offsetWidth; root.classList.remove('proto-side-instant'); }
    follow();
  };

  const toggle = () => {
    const expanded = !root.classList.contains('proto-side-expanded');
    if (narrow()) overlay = expanded; // 窄窗口：只临时展开成浮层，不改记住的偏好
    else localStorage.setItem(KEY, expanded ? 'expanded' : 'collapsed');
    apply(expanded);
  };
  t.addEventListener('click', toggle);

  // Ctrl+B / ⌘B（组合键，不用单键）；输入框和编辑器里不拦截
  addEventListener('keydown', (e) => {
    if (!(e.ctrlKey || e.metaKey) || e.altKey || e.shiftKey || e.key.toLowerCase() !== 'b') return;
    if (e.target.closest?.('input, textarea, select, [contenteditable], .cm-editor')) return;
    e.preventDefault();
    toggle();
  });
  // 浮层：选了页面、按 Esc、点到外面都收回
  const closeOverlay = () => { if (overlay) { overlay = false; apply(false); } };
  nav.addEventListener('click', (e) => { if (e.target.closest('[data-nav]')) closeOverlay(); });
  addEventListener('keydown', (e) => { if (e.key === 'Escape') closeOverlay(); });
  addEventListener('pointerdown', (e) => { if (overlay && !nav.contains(e.target)) closeOverlay(); });
  addEventListener('resize', () => { overlay = false; apply(narrow() ? false : saved() === 'expanded', { animate: false }); });

  apply(narrow() ? !!window.__PROTO_SIDE_OPEN__ : saved() === 'expanded', { animate: false });
  if (narrow() && window.__PROTO_SIDE_OPEN__) overlay = true;
  await new Promise((r) => setTimeout(r, 400));
  follow();
}
