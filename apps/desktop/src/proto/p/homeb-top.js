// 简洁首页方案 B + 最快节点：用户觉得 B 下方太空，加上最快节点条试试能不能填满。
// homeb-top：开关条 → 最快节点 → 流量卡
// homeb-top-bottom：开关条 → 流量卡 → 最快节点
import { post as homeB } from './homeb.js';
import { post as topNodes } from './topnodes.js';

export async function post() {
  const css = document.createElement('link');
  css.rel = 'stylesheet';
  css.href = 'proto/p/topnodes.css';
  document.head.appendChild(css);
  await new Promise((r) => { css.onload = r; css.onerror = r; });
  await homeB();
  await topNodes();
  const page = document.querySelector('[data-page="home"]');
  const strip = page.querySelector('.proto-strip');
  const top = page.querySelector('.proto-top');
  const hero = document.querySelector('#home-hero');
  if (window.__PROTO__ === 'homeb-top-bottom') hero.after(top);
  else strip.after(top);
  window.dispatchEvent(new Event('resize'));
}
