// #1477 系统代理绕过列表可编辑
import { insertRowAfter, settingRow, valueButton, ICONS, scrollSettingsTo } from './_kit.js';

export async function post() {
  insertRowAfter('#port-config-btn', settingRow({
    id: 'proto-bypass-row',
    iconPaths: ICONS.bypass,
    title: '系统代理绕过',
    desc: '这些域名和网段不走系统代理，直接连接',
    control: valueButton('默认 + 2 项'),
  }));
  await scrollSettingsTo('#proto-bypass-row');
}
