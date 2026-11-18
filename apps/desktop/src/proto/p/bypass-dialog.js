import { post as base } from './bypass.js';
import { dialog } from './_kit.js';

export async function post() {
  await base();
  dialog({
    title: '忽略的主机与域',
    sub: '每行输入一个主机或域。',
    width: 440,
    body: `
      <label class="block text-xs font-medium text-[var(--text-muted)] mb-2">自定义</label>
      <textarea class="form-control proto-mono" rows="5" spellcheck="false">*.corp.example.com
10.20.0.0/16</textarea>
      <div class="flex items-center justify-between mt-4 gap-4">
        <div class="min-w-0">
          <p class="text-xs font-semibold text-[var(--text-primary)]">忽略本地网络地址</p>
          <p class="text-2xs text-[var(--text-muted)] mt-0.5 truncate">localhost、127.*、10.*、172.16.*、192.168.*、&lt;local&gt;</p>
        </div>
        <label class="ios-switch shrink-0"><input type="checkbox" checked><span class="switch-slider"></span></label>
      </div>`,
  });
}
