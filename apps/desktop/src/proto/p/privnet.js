// #284 允许订阅地址解析到内网 IP（按订阅单独开，不加全局总开关）
// ?proto=privnet-before / privnet-after
import { html } from './_kit.js';
import { openEditDialog } from './_subs.js';

export async function post() {
  const modal = await openEditDialog(0);
  if (window.__PROTO__.endsWith('before')) return;
  const fields = modal.querySelector('.space-y-4');
  fields.appendChild(html(`<div class="proto-priv">
    <div class="flex items-center justify-between gap-4">
      <div class="min-w-0">
        <p class="text-xs font-semibold text-[var(--text-primary)]">允许解析到内网地址</p>
        <p class="edit-field-hint mt-0.5">只对这条订阅生效。机场域名被判成私有 IP、更新一直失败时再打开。</p>
      </div>
      <label class="ios-switch shrink-0"><input type="checkbox" checked><span class="switch-slider"></span></label>
    </div>
  </div>`));
}
