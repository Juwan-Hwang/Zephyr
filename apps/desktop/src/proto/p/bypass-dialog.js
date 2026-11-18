import { post as base } from './bypass.js';
import { dialog } from './_kit.js';

export async function post() {
  await base();
  dialog({
    title: '系统代理绕过',
    sub: '列表里的地址不走代理。每行一项，支持通配符和 CIDR。',
    width: 440,
    body: `
      <label class="block text-xs font-medium text-[var(--text-muted)] mb-2">自定义地址</label>
      <textarea class="form-control proto-mono" rows="5" spellcheck="false">*.corp.example.com
10.20.0.0/16</textarea>
      <div class="flex items-center justify-between mt-4 gap-4">
        <div class="min-w-0">
          <p class="text-xs font-semibold text-[var(--text-primary)]">同时绕过本地和局域网地址</p>
          <p class="text-2xs text-[var(--text-muted)] mt-0.5 truncate">localhost、127.*、10.*、172.16.*、192.168.*、&lt;local&gt;</p>
        </div>
        <label class="ios-switch shrink-0"><input type="checkbox" checked><span class="switch-slider"></span></label>
      </div>`,
  });
}
