// #490 #1127 内核可选：mihomo / mihomo Smart / sing-box
import { insertRowAfter, settingRow, ICONS, scrollSettingsTo } from './_kit.js';

export async function post() {
  insertRowAfter('#setting-unified-delay', settingRow({
    id: 'proto-kernel-row',
    iconPaths: ICONS.cpu,
    title: '代理内核',
    desc: '切换后会重新启动。覆写、规则和订阅转换仅支持 mihomo。',
    control: `<div class="seg-tabs shrink-0" role="radiogroup">
      <button type="button" class="seg-tab active" aria-checked="true">mihomo</button>
      <button type="button" class="seg-tab">Smart</button>
      <button type="button" class="seg-tab">sing-box</button>
    </div>`,
  }));
  await scrollSettingsTo('#proto-kernel-row');
}
