// #2314 自定义测速地址
import { insertRowAfter, settingRow, valueButton, ICONS, scrollSettingsTo } from './_kit.js';

export async function post() {
  insertRowAfter('#setting-unified-delay', settingRow({
    id: 'proto-testurl-row',
    iconPaths: ICONS.gauge,
    title: '测速地址',
    desc: '测试节点延迟时访问的地址。',
    control: valueButton('www.gstatic.com/generate_204'),
  }));
  await scrollSettingsTo('#proto-testurl-row');
}
