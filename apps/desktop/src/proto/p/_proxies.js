import { MOCK_PROXIES } from '../demo/mock-data.js';
import { $, $$, until, wait } from './_kit.js';

/** Rename nodes everywhere in the mock proxy set (before the app reads it). */
const sets = () => [MOCK_PROXIES.proxies, window.__protoProxyState().proxies];

export function renameNodes(map) {
  for (const set of sets()) renameIn(set, map);
}

function renameIn(set, map) {
  for (const [from, to] of Object.entries(map)) {
    if (!set[from]) continue;
    set[to] = { ...set[from], name: to };
    delete set[from];
  }
  for (const p of Object.values(set)) {
    if (Array.isArray(p.all)) p.all = p.all.map((n) => map[n] || n);
    if (p.now && map[p.now]) p.now = map[p.now];
  }
}

export function setNow(group, node) {
  for (const set of sets()) set[group].now = node;
}

export const LONG_NAMES = {
  '🇭🇰 香港 01': '🇭🇰 香港 01 | IEPL 专线 | x1.5',
  '🇭🇰 香港 02': '🇭🇰 香港 02 | HKT 家宽 | Netflix',
  '🇭🇰 香港 03 IPLC': '🇭🇰 香港 03 IPLC | 游戏专用 | x2',
  '🇯🇵 日本 东京 01': '🇯🇵 日本 东京 01 | 原生 IP | x1',
  '🇯🇵 日本 大阪 02': '🇯🇵 日本 大阪 02 | BGP 中转 | x1',
  '🇸🇬 新加坡 01': '🇸🇬 新加坡 01 | 流媒体解锁 | x1.5',
  '🇸🇬 新加坡 02': '🇸🇬 新加坡 02 | Disney+ | x1',
  '🇹🇼 台湾 01': '🇹🇼 台湾 01 | Hinet 家宽 | x1',
  '🇺🇸 美国 硅谷 01': '🇺🇸 美国 硅谷 01 | ChatGPT 可用',
  '🇺🇸 美国 洛杉矶 02': '🇺🇸 美国 洛杉矶 02 | CN2 GIA | x2',
  '🇰🇷 韩国 首尔 01': '🇰🇷 韩国 首尔 01 | 原生 IP | x1',
  '🇬🇧 英国 伦敦 01': '🇬🇧 英国 伦敦 01 | BBC iPlayer | x1',
};

export async function proxiesReady() {
  await until(() => $$('#proxies-list [data-name]').length > 4, 6000);
  await wait(300);
}

export async function sortByLatency() {
  $('#sort-btn')?.click();
  await wait(250);
  const items = $$('[role="menuitemradio"]');
  const lat = items.find((b) => /延迟/.test(b.textContent)) || items[2];
  lat?.click();
  await wait(700);
}
