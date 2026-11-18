// #2439 / #673 变体 A：开关卡整体移到最上面，订阅下拉放进系统代理卡
import { homeParts, subSelect } from './_home.js';
import { isConsole, consoleParts } from './_con.js';

export async function post() {
  if (isConsole()) {
    // 控制台首页：「快捷控制」卡移到右栏最上面，订阅下拉放进它的标题行
    const { side, nodeWrap, quickCard } = await consoleParts();
    side.prepend(quickCard);
    quickCard.style.flex = 'none';
    quickCard.style.overflow = 'visible';
    quickCard.style.zIndex = '40';
    nodeWrap.style.flex = '1';
    const head = quickCard.querySelector('.dz-card-head');
    head.append(subSelect({ open: !!window.__PROTO_OPEN__, width: 132, compact: true }));
    window.dispatchEvent(new Event('resize'));
    return;
  }
  const { page, hero, sysCard, grid } = await homeParts();
  page.prepend(grid);
  page.prepend(sysCard);
  page.append(hero);
  const sw = sysCard.querySelector('.ios-switch');
  const wrap = document.createElement('div');
  wrap.className = 'flex items-center gap-4 shrink-0';
  sw.replaceWith(wrap);
  wrap.append(subSelect({ open: !!window.__PROTO_OPEN__ }), sw);
  sysCard.style.zIndex = '40';
  window.dispatchEvent(new Event('resize'));
}
