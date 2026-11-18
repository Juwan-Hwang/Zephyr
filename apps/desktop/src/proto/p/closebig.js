// #69 #282 关闭按钮做得更大。?proto=closebig-dot（放大圆点）/ closebig-x（常规 × 按钮）
import { $, until } from './_kit.js';

export async function post() {
  const close = await until(() => $('#close-btn'));
  const v = window.__PROTO__.split('-')[1];
  close.classList.add(`proto-close-${v}`);
}
