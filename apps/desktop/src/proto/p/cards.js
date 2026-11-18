// #2314 节点卡片最小宽度，定为 200。?proto=cards-200
import { renameNodes, LONG_NAMES, proxiesReady } from './_proxies.js';

export function pre() {
  renameNodes(LONG_NAMES);
  const w = (window.__PROTO__.split('-')[1]) || '200';
  const st = document.createElement('style');
  st.textContent = `#proxies-list { grid-template-columns: repeat(auto-fill, minmax(${w}px, 1fr)) !important; }`;
  document.head.appendChild(st);
}

export async function post() {
  await proxiesReady();
}
