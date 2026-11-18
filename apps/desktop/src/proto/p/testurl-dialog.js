import { post as base } from './testurl.js';
import { dialog } from './_kit.js';

export async function post() {
  await base();
  // 常用地址用新的通用选择卡片（styles.css 里的 .choice-grid / .choice-card）：
  // 每项一个名字加一行域名，选中时 accent 描边 + 浅色底 + 3px 辉光环。
  const presets = [
    ['Google', 'www.gstatic.com', false],
    ['Cloudflare', 'cp.cloudflare.com', true],
    ['Apple', 'captive.apple.com', false],
    ['小米', 'connect.rom.miui.com', false],
  ];
  dialog({
    title: '测速地址',
    sub: '如果延迟总是显示超时，可以换一个地址。',
    width: 440,
    body: `
      <div class="flex flex-col gap-1.5 mb-4">
        <span class="text-xs font-medium text-[var(--text-muted)]">常用地址</span>
        <div class="choice-grid" role="radiogroup" aria-label="常用地址">
          ${presets.map(([n, h, on]) => `<button type="button" role="radio" aria-checked="${on}" class="choice-card"><span class="choice-card-title">${n}</span><span class="choice-card-desc">${h}</span></button>`).join('')}
        </div>
      </div>
      <div class="flex flex-col gap-1.5">
        <span class="text-xs font-medium text-[var(--text-muted)]">地址</span>
        <input type="text" class="form-control form-control-md proto-mono" value="https://cp.cloudflare.com/generate_204">
        <p class="edit-field-hint">留空则使用 Google。</p>
      </div>`,
  });
}
