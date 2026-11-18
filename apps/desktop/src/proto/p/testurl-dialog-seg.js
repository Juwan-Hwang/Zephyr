// 对比用：上一版测速地址弹窗（分段控件 .seg-tabs-lg），用户已改回选择卡片
import { post as base } from './testurl.js';
import { dialog } from './_kit.js';

export async function post() {
  await base();
  // 预设用设置里已有的分段控件（.seg-tabs-lg + .seg-tab.active），
  // 和订阅弹窗的「自动更新」、隧道弹窗的「协议」同一个组件、同一个选中态。
  const presets = [
    ['Google', false],
    ['Cloudflare', true],
    ['Apple', false],
    ['小米', false],
  ];
  dialog({
    title: '测速地址',
    sub: '如果延迟总是显示超时，可以换一个地址。',
    width: 440,
    body: `
      <div class="flex flex-col gap-1.5 mb-4">
        <span class="text-xs font-medium text-[var(--text-muted)]">常用地址</span>
        <div class="seg-tabs seg-tabs-lg w-full" role="radiogroup" aria-label="常用地址">
          ${presets.map(([n, on]) => `<button type="button" role="radio" aria-checked="${on}" class="seg-tab ${on ? 'active ' : ''}flex-1 justify-center">${n}</button>`).join('')}
        </div>
      </div>
      <div class="flex flex-col gap-1.5">
        <span class="text-xs font-medium text-[var(--text-muted)]">地址</span>
        <input type="text" class="form-control form-control-md proto-mono" value="https://cp.cloudflare.com/generate_204">
        <p class="edit-field-hint">留空则使用 Google。</p>
      </div>`,
  });
}
