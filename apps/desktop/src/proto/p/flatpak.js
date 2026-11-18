// #1449 Flatpak 版关闭自更新（检测到 FLATPAK_ID）
import { $, icon, ICONS, scrollSettingsTo, until } from './_kit.js';

export async function post() {
  await until(() => $('#check-update-btn'));
  if (window.__PROTO__.endsWith('after')) {
    const btn = $('#check-update-btn');
    btn.outerHTML = `<span class="proto-pill">${icon(ICONS.package, 'w-3 h-3')}由 Flathub 更新</span>`;
    const toggle = $('#setting-auto-update-client');
    const row = toggle.closest('.flex.items-center.justify-between');
    row.classList.add('proto-disabled-row');
    toggle.checked = false;
    toggle.disabled = true;
    $('#setting-auto-update-client-desc').textContent = '可以在软件中心检查更新。';
  }
  await scrollSettingsTo('#app-version-text', 'start');
  $('#app-version-text').closest('.glass-card').parentElement.scrollIntoView({ block: 'start' });
}
