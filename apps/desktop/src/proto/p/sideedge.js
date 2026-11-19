// @ts-nocheck -- 原型代码：测试钩子挂在 window 上，不做类型检查
// 定稿侧栏（第三版）：353e083 那一版的「原来的图标 + 两个字的名字」，能展开和收起，但不加任何按钮。
// 用户否决了底部的「隐藏边栏」图标按钮，侧栏本身（图标 + 文字）保留。展开和收起改用桌面应用里现成的做法：
//   1. 拖动侧栏右边缘：往左拖过一半就收成只有图标，往右拖过一半就展开（Finder、VS Code、Notion 的做法），双击边缘直接切换。
//   2. 键盘：macOS 上 ⌃⌘S（macOS 标准「显示边栏 / 隐藏边栏」命令的快捷键），Windows 和 Linux 上 Ctrl+B（VS Code 的惯例）。
//   3. 右键侧栏：菜单里只有一项「收起边栏 / 展开边栏」，旁边写着快捷键，顺便教会快捷键。
//   4. 窗口窄于 860 px 时自动收起成只有图标；这时再展开，侧栏浮在内容上方，选完页面、按 Esc、点外面就收回。
// 状态会记住。收起时用 main 原有的侧栏悬停提示（ui/nav-tooltip.js）显示名字。
// 测试钩子：window.__PROTO_SIDE__ = 'collapsed' | 'expanded'；window.__PROTO_SIDE_OPEN__ = true（窄窗口展开成浮层）；
//          window.__protoSide.menu(x, y) 打开右键菜单；window.__protoSide.edge(true) 显示边缘的悬停态。
import { $, $$, until } from './_kit.js';

const SHORT = { home: '首页', proxies: '节点', subscriptions: '订阅', connections: '连接', 'rule-library': '规则', logs: '日志', settings: '设置', overrides: '覆写', plugins: '插件', console: '控制台' };
const KEY = 'zephyr.sidebar';
const NARROW = 860;
const MAC = /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent);
const SHORTCUT = MAC ? '⌃⌘S' : 'Ctrl+B';

export async function post() {
  await until(() => $$('#sidebar-nav [data-nav]').length > 3);
  const root = document.documentElement;
  const nav = $('#sidebar-nav');
  root.classList.add('proto-side-fold', 'proto-side-edge');

  for (const b of $$('#sidebar-nav [data-nav]')) {
    if (b.querySelector('.proto-nav-label')) continue;
    const sr = b.querySelector('.sr-only');
    if (sr && SHORT[b.dataset.nav]) sr.textContent = SHORT[b.dataset.nav];
    const s = document.createElement('span');
    s.className = 'proto-nav-label';
    s.setAttribute('aria-hidden', 'true');
    s.textContent = SHORT[b.dataset.nav] || sr?.textContent || '';
    b.appendChild(s);
  }

  // 右边缘：平时看不见，悬停时出现一条细线、光标变成左右箭头。键盘可以聚焦（WAI-ARIA 的窗口分隔条），←/→/回车切换。
  const edge = document.createElement('div');
  edge.className = 'proto-side-edge-handle';
  edge.setAttribute('role', 'separator');
  edge.setAttribute('aria-orientation', 'vertical');
  edge.setAttribute('aria-controls', 'sidebar-nav');
  edge.setAttribute('aria-keyshortcuts', MAC ? 'Control+Meta+S' : 'Control+B');
  edge.tabIndex = 0;
  nav.appendChild(edge);

  const menu = document.createElement('div');
  menu.className = 'proto-side-menu';
  menu.setAttribute('role', 'menu');
  menu.hidden = true;
  const mItem = document.createElement('button');
  mItem.type = 'button';
  mItem.className = 'proto-side-menu-item';
  mItem.setAttribute('role', 'menuitem');
  const mLabel = document.createElement('span');
  mLabel.className = 'psm-label';
  const mKey = document.createElement('kbd');
  mKey.className = 'psm-key';
  mKey.textContent = SHORTCUT;
  mItem.append(mLabel, mKey);
  menu.appendChild(mItem);
  document.body.appendChild(menu);

  const narrow = () => innerWidth < NARROW;
  const saved = () => window.__PROTO_SIDE__ || localStorage.getItem(KEY) || 'expanded';
  const isExpanded = () => root.classList.contains('proto-side-expanded');
  let overlay = false;

  // 选中项的高亮块是单独定位的；宽度过渡期间逐帧跟住选中按钮
  let raf = 0, moving = false;
  nav.addEventListener('transitionrun', (e) => { if (e.target === nav && e.propertyName === 'width') { moving = true; follow(); } });
  const stop = (e) => { if (e.target === nav && e.propertyName === 'width') moving = false; };
  nav.addEventListener('transitionend', stop);
  nav.addEventListener('transitioncancel', stop);
  const place = () => {
    const ind = $('#sidebar-nav .nav-indicator');
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
    edge.setAttribute('aria-label', expanded ? `收起边栏（${SHORTCUT}）` : `展开边栏（${SHORTCUT}）`);
    edge.setAttribute('aria-expanded', String(expanded));
    $('#nav-tooltip')?.classList.remove('is-visible');
    if (!animate) { void nav.offsetWidth; root.classList.remove('proto-side-instant'); }
    follow();
  };
  const set = (expanded) => {
    if (expanded === isExpanded()) return;
    if (narrow()) overlay = expanded; // 窄窗口：只临时展开成浮层，不改记住的偏好
    else localStorage.setItem(KEY, expanded ? 'expanded' : 'collapsed');
    apply(expanded);
  };
  const toggle = () => set(!isExpanded());

  // 1. 拖动右边缘：按住后跟着指针，越过收起和展开宽度的中点就切换（吸附，不停在中间宽度）
  edge.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return;
    e.preventDefault();
    edge.setPointerCapture(e.pointerId);
    root.classList.add('proto-side-dragging');
    const left = nav.getBoundingClientRect().left;
    const mid = (80 + 160) / 2;
    const move = (ev) => set(ev.clientX - left > mid);
    const up = () => {
      root.classList.remove('proto-side-dragging');
      edge.removeEventListener('pointermove', move);
      edge.removeEventListener('pointerup', up);
      edge.removeEventListener('pointercancel', up);
    };
    edge.addEventListener('pointermove', move);
    edge.addEventListener('pointerup', up);
    edge.addEventListener('pointercancel', up);
  });
  edge.addEventListener('dblclick', toggle);
  edge.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowLeft') { e.preventDefault(); set(false); }
    else if (e.key === 'ArrowRight') { e.preventDefault(); set(true); }
    else if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggle(); }
  });

  // 2. 快捷键（组合键；输入框和编辑器里不拦截）
  addEventListener('keydown', (e) => {
    const k = e.key.toLowerCase();
    const hit = MAC ? (e.ctrlKey && e.metaKey && !e.altKey && !e.shiftKey && k === 's')
                    : (e.ctrlKey && !e.metaKey && !e.altKey && !e.shiftKey && k === 'b');
    if (!hit) return;
    if (e.target.closest?.('input, textarea, select, [contenteditable], .cm-editor')) return;
    e.preventDefault();
    toggle();
  });

  // 3. 右键菜单
  const item = menu.querySelector('.proto-side-menu-item');
  const closeMenu = () => { menu.hidden = true; };
  const openMenu = (x, y, kbd = false) => {
    item.querySelector('.psm-label').textContent = isExpanded() ? '收起边栏' : '展开边栏';
    menu.hidden = false;
    const r = menu.getBoundingClientRect();
    menu.style.left = `${Math.min(x, innerWidth - r.width - 8)}px`;
    menu.style.top = `${Math.min(y, innerHeight - r.height - 8)}px`;
    // 鼠标打开时不预先高亮（和系统菜单一样），键盘（菜单键 / Shift+F10）打开时高亮第一项
    item.focus({ preventScroll: true, focusVisible: !!kbd });
  };
  nav.addEventListener('contextmenu', (e) => {
    e.preventDefault();
    const kbd = e.button !== 2 || (e.clientX === 0 && e.clientY === 0);
    if (kbd) { const r = (document.activeElement?.closest?.('#sidebar-nav .nav-btn') || nav).getBoundingClientRect(); openMenu(r.right - 8, r.top + r.height / 2, true); }
    else openMenu(e.clientX, e.clientY);
  });
  item.addEventListener('click', () => { closeMenu(); toggle(); });
  addEventListener('pointerdown', (e) => { if (!menu.hidden && !menu.contains(e.target)) closeMenu(); }, true);
  addEventListener('blur', closeMenu);

  // 4. 窄窗口的浮层：选了页面、按 Esc、点到外面都收回
  const closeOverlay = () => { if (overlay) { overlay = false; apply(false); } };
  nav.addEventListener('click', (e) => { if (e.target.closest('[data-nav]')) closeOverlay(); });
  addEventListener('keydown', (e) => { if (e.key !== 'Escape') return; if (!menu.hidden) closeMenu(); else closeOverlay(); });
  addEventListener('pointerdown', (e) => { if (overlay && !nav.contains(e.target) && !menu.contains(e.target)) closeOverlay(); });
  addEventListener('resize', () => { overlay = false; closeMenu(); apply(narrow() ? false : saved() === 'expanded', { animate: false }); });

  window.__protoSide = {
    menu: openMenu,
    edge: (on) => root.classList.toggle('proto-side-edge-show', on),
    set,
  };

  apply(narrow() ? !!window.__PROTO_SIDE_OPEN__ : saved() === 'expanded', { animate: false });
  if (narrow() && window.__PROTO_SIDE_OPEN__) overlay = true;
  await new Promise((r) => setTimeout(r, 400));
  follow();
}
