// #69 当前节点也参与延迟排序。?proto=sortcur-before / sortcur-after
import { $, $$, wait } from './_kit.js';
import { setNow, proxiesReady, sortByLatency } from './_proxies.js';

export function pre() {
  setNow('🚀 节点选择', '🇺🇸 美国 硅谷 01');
}

export async function post() {
  await proxiesReady();
  await sortByLatency();
  if (!window.__PROTO__.endsWith('after')) return;
  const list = $('#proxies-list');
  const ms = (w) => {
    const t = w.querySelector('[id^="latency-"]')?.textContent || '';
    const n = parseInt(t, 10);
    return Number.isFinite(n) ? n : 1e9;
  };
  const cards = [...list.children];
  cards.map((c, i) => [c, ms(c), i]).sort((a, b) => a[1] - b[1] || a[2] - b[2]).forEach(([c], i) => { c.style.order = String(i); list.appendChild(c); });
  await wait(200);
}
