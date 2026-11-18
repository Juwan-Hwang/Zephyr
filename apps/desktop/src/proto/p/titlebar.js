// #178 标题栏加最小化、最大化按钮（和现有关闭圆点同一风格）
import { $, html, until } from './_kit.js';

export async function post() {
  const close = await until(() => $('#close-btn'));
  const mk = (cls, label, path) => html(`<button type="button" class="group relative flex items-center justify-center w-3.5 h-3.5 rounded-full ${cls} transition-colors shadow-sm before:absolute before:-inset-1.5 before:content-['']" aria-label="${label}" title="${label}"><svg aria-hidden="true" class="proto-tl-glyph w-2 h-2" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="4" stroke-linecap="round" stroke-linejoin="round">${path}</svg></button>`);
  close.before(mk('proto-tl-min', '最小化', '<line x1="5" y1="12" x2="19" y2="12"/>'));
  close.before(mk('proto-tl-max', '最大化', '<path d="M8 4H4v4M16 4h4v4M8 20H4v-4M16 20h4v-4"/>'));
  close.parentElement.classList.add('proto-tl-row');
}
