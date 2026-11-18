// #2439 / #673 变体 A：开关卡整体移到最上面，订阅下拉放进系统代理卡
import { homeParts, subSelect } from './_home.js';

export async function post() {
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
