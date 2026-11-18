// #2439 窗口四个角的缩放热区。?proto=corners-before / corners-after
// 正式实现：四个 12×12 透明块，pointerdown 时调用
// getCurrentWindow().startResizeDragging('NorthWest' | 'NorthEast' | 'SouthWest' | 'SouthEast')，
// 配 nwse/nesw 光标，最大化时隐藏。截图里用半透明色块把热区标出来。
import { html } from './_kit.js';

export async function post() {
  const after = window.__PROTO__.endsWith('after');
  const size = after ? 12 : 3; // before: 只剩角上一两个像素能拖
  const corners = [['nw', 'top:0;left:0', 'nwse-resize'], ['ne', 'top:0;right:0', 'nesw-resize'], ['sw', 'bottom:0;left:0', 'nesw-resize'], ['se', 'bottom:0;right:0', 'nwse-resize']];
  for (const [k, pos, cur] of corners) {
    document.body.appendChild(html(`<div class="proto-resize-corner proto-annot" data-corner="${k}" style="${pos};width:${size}px;height:${size}px;cursor:${cur}"></div>`));
    const zoom = html(`<div class="proto-corner-zoom proto-annot" data-corner="${k}" style="${pos.replace(/0/g, '18px')}"><span>${after ? '12 × 12 px' : '约 2 px'}</span></div>`);
    document.body.appendChild(zoom);
  }
}
