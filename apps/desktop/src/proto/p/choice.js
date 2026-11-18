// 新组件：选择卡片（styles.css .choice-grid / .choice-card）用在其他卡片式单选的地方。
// ?proto=choice-logexport-before / -after：导出日志弹窗里的「导出内容」
// ?proto=choice-homemode-before / -after：外观里的「主页模式」
// ?proto=choice-states：测速地址弹窗里的 hover / focus-visible / 选中三种状态放在一起
import { $, until, wait, scrollSettingsTo } from './_kit.js';

const card = (title, desc, on) => `<button type="button" role="radio" aria-checked="${on}" class="choice-card"><span class="choice-card-title">${title}</span><span class="choice-card-desc">${desc}</span></button>`;

async function logExport(after) {
  await scrollSettingsTo('#log-export-btn');
  $('#log-export-btn').click();
  const seg = await until(() => $('#log-export-modal .seg-tabs-lg'));
  await wait(500);
  if (!after || !seg) return;
  const grid = document.createElement('div');
  grid.className = 'choice-grid';
  grid.style.setProperty('--choice-cols', '3');
  grid.setAttribute('role', 'radiogroup');
  grid.setAttribute('aria-label', seg.getAttribute('aria-label') || '');
  grid.innerHTML = [
    card('应用日志', '界面、订阅、设置出错', false),
    card('核心日志', '连不上、节点和规则', false),
    card('全部', '不确定时选这个', true),
  ].join('');
  seg.replaceWith(grid);
}

async function homeMode(after) {
  await scrollSettingsTo('#setting-home-mode-container');
  if (!after) return;
  const seg = $('#setting-home-mode-container');
  const row = seg.parentElement; // 整行：左边图标+标题，右边分段控件
  seg.style.display = 'none';
  const wrap = document.createElement('div');
  wrap.className = 'proto-new';
  wrap.innerHTML = `<div class="choice-grid" role="radiogroup" aria-label="主页模式" style="margin-inline-start:36px">
    ${card('极简', '大号网速和当前节点，一眼看清', true)}
    ${card('控制台', '流量图、连接和订阅，一屏看全', false)}
  </div>`;
  row.after(wrap);
  wrap.style.marginTop = '12px';
  await scrollSettingsTo('#setting-home-mode-container');
}

export async function post() {
  const n = window.__PROTO__;
  if (n.startsWith('choice-logexport')) return logExport(n.endsWith('after'));
  if (n.startsWith('choice-homemode')) return homeMode(n.endsWith('after'));
}
