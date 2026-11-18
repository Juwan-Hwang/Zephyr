// 控制台首页（home_page_mode = console，ui/console-home.js）的原型辅助。
// 涉及首页的原型在两种首页模式下各做一版：模块里先判断 isConsole()，
// 控制台走 consoleParts() 拿到的这些节点，只用 console-home 已有的结构和样式。
import { $, until } from './_kit.js';

export const isConsole = () => new URLSearchParams(location.search).get('home') === 'console';

export async function consoleParts() {
  await until(() => $('.dz-content #dz-node-name') && $('#dz-mode-seg'));
  const content = $('.dz-content');
  const header = $('.dz-header', content);
  const kpis = $('.dz-kpis', content);
  const main = $('.dz-grid-main', content);
  const traffic = $('#dz-traffic-card');
  const side = $('.dz-side', content);
  const nodeWrap = $('.dz-node-wrap', side);
  const nodeCard = $('.glass-card', nodeWrap);
  const quickCard = $('#dz-mode-seg').closest('.glass-card');
  const bottom = $('.dz-grid-bottom', content);
  const subCard = $('#dz-sub-name').closest('.glass-card');
  return { content, header, kpis, main, traffic, side, nodeWrap, nodeCard, quickCard, bottom, subCard };
}

// 控制台首页方案 B（用户倾向）作为其他控制台原型的底：先套 B，再加各自的改动。
export async function applyConsoleB() {
  if (!document.querySelector('link[data-proto-b]')) {
    const l = document.createElement('link');
    l.rel = 'stylesheet';
    l.href = 'proto/p/homeb.css';
    l.dataset.protoB = '1';
    const loaded = new Promise((r) => { l.onload = r; l.onerror = r; });
    document.head.appendChild(l);
    await loaded;
  }
  const { consoleB } = await import('./homeb.js');
  await consoleB();
}
