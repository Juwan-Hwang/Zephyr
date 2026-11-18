// 新组件：选择卡片（styles.css .choice-grid / .choice-card）。
// 规则：4 个及以上选项的单选用选择卡片，2–3 个用分段滑块（.seg-tabs）。
// 导出日志「导出内容」（3 个）和外观「主页模式」（2 个）因此保持原来的分段控件，原型已删。
// ?proto=choice-subauto-before / -after：订阅编辑弹窗里的「自动更新」（4 个预设）
// ?proto=choice-states：测速地址弹窗里的 hover / focus-visible / 选中三种状态放在一起
import { wait } from './_kit.js';
import { openEditDialog } from './_subs.js';

async function subAuto(after) {
  const modal = await openEditDialog(0);
  const seg = modal.querySelector('#edit-auto-update');
  if (!after || !seg) return;
  // 和 ui/settings/subscriptions.js 一样的数据：按钮保留 data-value，只换外观；
  // 选择卡片同样是 role=radio + aria-checked，原来的点击处理只需把 .seg-tab 换成 .choice-card。
  const grid = document.createElement('div');
  grid.id = 'edit-auto-update';
  grid.className = 'choice-grid';
  grid.style.setProperty('--choice-cols', '4');
  grid.setAttribute('role', 'radiogroup');
  grid.setAttribute('aria-labelledby', 'edit-auto-update-label');
  grid.innerHTML = [...seg.querySelectorAll('.seg-tab')].map((b) => {
    const on = b.classList.contains('active');
    return `<button type="button" role="radio" aria-checked="${on}" data-value="${b.dataset.value}" class="choice-card proto-choice-compact"><span class="choice-card-title">${b.textContent}</span></button>`;
  }).join('');
  seg.replaceWith(grid);
  await wait(200);
}

export async function post() {
  const n = window.__PROTO__;
  if (n.startsWith('choice-subauto')) return subAuto(n.endsWith('after'));
}
