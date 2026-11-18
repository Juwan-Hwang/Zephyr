// #1477 系统代理绕过列表可编辑
import { insertRowAfter, settingRow, valueButton, ICONS, scrollSettingsTo } from './_kit.js';

export async function post() {
  insertRowAfter('#port-config-btn', settingRow({
    id: 'proto-bypass-row',
    iconPaths: ICONS.bypass,
    title: '忽略的主机与域',
    desc: '访问这些地址时不使用代理。',
    control: valueButton('2 项'),
  }));
  await scrollSettingsTo('#proto-bypass-row');
}
