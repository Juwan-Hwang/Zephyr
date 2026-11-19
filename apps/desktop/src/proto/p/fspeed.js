// 定稿：测试下载速度（#2314，对照 v2rayN 的「测速」和「一键多线程测试延迟和速度」）。
// 触发：代理页顶部「测试下载速度」= 当前分组全部节点；节点卡悬停按钮 = 单个节点。
// 过程：先测延迟，超时的跳过；一次测一个（不并发，并发会分掉带宽，结果没法比）；
//       每个节点下载测速文件，下完或到超时就停；结果取每秒速度的最高值，单位 MB/s，一位小数。
// 反馈：顶部按钮变成「停止测试 3/11」，按 Esc 也能停；正在测的卡片描边、底部进度条、速度每秒刷新。
// 结果：卡片底部的协议位置换成下载速度；排序菜单多一项「按下载速度」。
// ?proto=final + __F__.feat: speed-menu / speed-confirm / speed-run / speed-done / speed-sort / speed-setting / speed-dialog
import { $, $$, html, icon, ICONS, wait, until, dialog, insertRowAfter, settingRow, valueButton, scrollSettingsTo } from './_kit.js';
import { proxiesReady } from './_proxies.js';

const DL = '<path d="M12 4v12"/><path d="m7 11 5 5 5-5"/><path d="M5 20h14"/>';
const STOP = '<rect x="7" y="7" width="10" height="10" rx="2"/>';
// 按卡片顺序：结果（MB/s），null = 延迟超时已跳过
const RESULT = {
  '香港 01': 41.2, '香港 02': 18.7, '香港 03': 38.6, '东京 01': 26.3, '大阪 02': 33.9,
  '新加坡 01': 21.4, '新加坡 02': 12.8, '台湾 01': 29.5, '硅谷 01': 9.6, '洛杉矶 02': 15.1, '首尔 01': 24.0, '伦敦 01': null,
};
const keyOf = (name) => Object.keys(RESULT).find((k) => name.replace(/日本 |美国 |韩国 |英国 /, '').includes(k));
const cards = () => $$('#proxies-list > [data-name]').filter((c) => keyOf(c.dataset.name));
const speedHtml = (v, live) => v == null
  ? '<span class="fs-speed is-muted">已跳过</span>'
  : `<span class="fs-speed${live ? ' is-live' : ''}">${icon(DL, 'w-3 h-3')}${v.toFixed(1)} MB/s</span>`;

/** 卡片底部协议那一格（如「VLESS · TCP」） */
function protoCell(card) {
  return [...card.querySelectorAll('span,p,div')].find((e) => e.children.length === 0 && /· (TCP|QUIC|UDP)/.test(e.textContent));
}
function setSpeed(card, inner) {
  const cell = protoCell(card);
  if (!cell) return;
  cell.dataset.fsWas = cell.dataset.fsWas || cell.textContent;
  cell.innerHTML = inner;
}

export function headerButton(state = 'idle', done = 0, total = cards().length) {
  const test = $('#test-all-btn');
  const b = html(state === 'run'
    ? `<button type="button" id="fs-all-btn" class="btn-ghost fs-btn is-running" aria-keyshortcuts="Escape">${icon(STOP, 'w-3.5 h-3.5')}<span class="fs-label">停止测试</span><span class="fs-count">${done}/${total}</span></button>`
    : `<button type="button" id="fs-all-btn" class="btn-ghost fs-btn">${icon(DL, 'w-3.5 h-3.5')}<span class="fs-label">测试下载速度</span></button>`);
  b.className += ' ' + [...test.classList].filter((c) => !/btn-accent|btn-primary/.test(c)).join(' ');
  // 用户决定：「测试延迟」在前，「测试下载速度」在后（两个按钮交换了位置）
  test.after(b);
  b.setAttribute('aria-label', state === 'run' ? `停止测试，已完成 ${done}/${total}` : '测试下载速度');
  if (state === 'run') test.setAttribute('disabled', '');
  fitHeader(b.closest('header'));
  return b;
}

// 用户决定：空间不够时先收起「测试下载速度」，「测试延迟」尽量一直带文字露在外面。
// 顺序：① 下载测速只留图标 → ② 排序等其他按钮只留图标（main 的 is-compact，测试延迟仍带文字）
//      → ③ 搜索框收窄到 96 px → ④ 最后才让测试延迟只留图标。
const FIT = ['fs-dl-icon', 'is-compact', 'fs-narrow', 'fs-lat-icon'];
function fitHeader(header) {
  if (!header) return;
  const run = () => {
    if (!header.clientWidth) return;
    header.classList.remove(...FIT);
    for (const step of FIT) {
      if (header.scrollWidth <= header.clientWidth + 1) break;
      header.classList.add(step);
    }
    const dl = header.querySelector('#fs-all-btn');
    if (dl) {
      if (header.classList.contains('fs-dl-icon')) dl.setAttribute('title', dl.textContent.replace(/\s+/g, ' ').trim().replace(/(\d+\/\d+)$/, ' $1'));
      else dl.removeAttribute('title');
    }
  };
  run();
  if (!header.dataset.fsFit) {
    header.dataset.fsFit = '1';
    // main 的 header-fit 也在 resize 时重排，等它跑完再按上面的顺序重来一遍
    new ResizeObserver(() => requestAnimationFrame(() => requestAnimationFrame(run))).observe(header);
  }
}

async function menu() {
  headerButton();
  const card = cards().find((c) => c.dataset.name.includes('香港 03'));
  const retest = card.querySelector('.node-retest-btn');
  const btn = html(`<button type="button" class="node-retest-btn proto-speed-btn" aria-label="测试下载速度">${icon(DL, 'w-3 h-3')}</button>`);
  retest.after(btn);
  card.classList.add('proto-force-hover');
  const r = btn.getBoundingClientRect();
  // 提示放在按钮正下方（系统提示的默认位置）：落在两行卡片之间的空隙里，不盖住本卡的协议名，也够不到下一张卡的节点名
  document.body.appendChild(html(`<div class="proto-tip fs-tip" role="tooltip" style="top:${r.bottom + 6}px;left:${r.left + r.width / 2}px;transform:translateX(-50%)">测试下载速度</div>`));
}

function confirm() {
  headerButton();
  const n = cards().length;
  dialog({
    title: `测试 ${n} 个节点的下载速度？`,
    body: `<p class="fs-dialog-note">将逐个测试「🚀 节点选择」中的节点，每个最多 10 秒，最多使用约 ${(n * 50 / 1000).toFixed(1)} GB 流量。</p>`,
    primary: '测试',
    width: 400,
  });
}

function run() {
  headerButton('run', 3);
  const list = cards();
  list.forEach((c, i) => {
    const k = keyOf(c.dataset.name);
    if (i < 3) setSpeed(c, speedHtml(RESULT[k]));
    else if (i === 3) {
      c.classList.add('fs-testing');
      c.style.position = 'relative';
      setSpeed(c, speedHtml(17.3, true));
      c.appendChild(html('<div class="fs-progress" role="progressbar" aria-label="正在测试下载速度" aria-valuenow="40" aria-valuemin="0" aria-valuemax="100"><span style="width:40%"></span></div>'));
    } else setSpeed(c, '<span class="fs-speed is-muted">等待中</span>');
  });
}

function done() {
  headerButton();
  for (const c of cards()) setSpeed(c, speedHtml(RESULT[keyOf(c.dataset.name)]));
}

async function sort() {
  done();
  // 按下载速度从快到慢排；跳过的和没测的排在后面
  const list = $('#proxies-list');
  const all = $$('#proxies-list > [data-name]');
  const tested = cards().sort((x, y) => (RESULT[keyOf(y.dataset.name)] ?? -1) - (RESULT[keyOf(x.dataset.name)] ?? -1));
  const rest = all.filter((c) => !tested.includes(c));
  const head = rest.filter((c) => /自动选择/.test(c.dataset.name));
  [...head, ...tested, ...rest.filter((c) => !head.includes(c))].forEach((c, i) => { list.appendChild(c); c.style.order = String(i); });
  $('#sort-btn')?.click();
  await until(() => $$('.proxy-sort-option').length > 2);
  const items = $$('.proxy-sort-option');
  const last = items[items.length - 1];
  const item = last.cloneNode(true);
  item.querySelector('.proxy-sort-title').textContent = '按下载速度';
  const d = item.querySelector('.proxy-sort-desc');
  if (d) d.textContent = '下载最快的排在前面';
  const checkSvg = items.map((x) => x.querySelector('.proxy-group-check').innerHTML).find(Boolean) || '';
  items.forEach((x) => { x.setAttribute('aria-checked', 'false'); x.querySelector('.proxy-group-check').innerHTML = ''; });
  item.setAttribute('aria-checked', 'true');
  item.querySelector('.proxy-group-check').innerHTML = checkSvg;
  last.after(item);
  // 「按延迟」的说明原来是「最快的排在前面」，和「按下载速度」放在一起会分不清
  for (const x of items) { const dd = x.querySelector('.proxy-sort-desc'); if (dd && dd.textContent.trim() === '最快的排在前面') dd.textContent = '延迟最低的排在前面'; }
  const label = $('#sort-btn .sort-label, #sort-label, #sort-btn span:not(.sr-only)');
  if (label && label.textContent.trim()) label.textContent = '按下载速度';
}

export function settingRowHtml() {
  return settingRow({
    id: 'fs-setting-row',
    iconPaths: DL,
    title: '下载测速',
    desc: '测试下载速度时使用的文件。',
    control: valueButton('CacheFly 50 MB'),
  });
}

async function setting(withDialog) {
  insertRowAfter('#proto-testurl-row', settingRowHtml());
  await scrollSettingsTo('#fs-setting-row');
  if (!withDialog) return;
  const presets = [
    ['CacheFly 50 MB', 'cachefly.cachefly.net', true],
    ['CacheFly 10 MB', 'cachefly.cachefly.net', false],
    ['Cloudflare 10 MB', 'speed.cloudflare.com', false],
    ['自定义', '输入文件地址', false],
  ];
  dialog({
    title: '下载测速',
    width: 440,
    body: `
      <p class="fs-field-label">测速文件</p>
      <div class="choice-grid" role="radiogroup" aria-label="测速文件">
        ${presets.map(([n, h, on]) => `<button type="button" role="radio" aria-checked="${on}" class="choice-card"><span class="choice-card-title">${n}</span><span class="choice-card-desc">${h}</span></button>`).join('')}
      </div>
      <p class="fs-field-label">每个节点最多测试</p>
      <div class="seg-tabs fs-seg" role="radiogroup" aria-label="每个节点最多测试">
        <button type="button" role="radio" aria-checked="true" class="seg-tab active">10 秒</button>
        <button type="button" role="radio" aria-checked="false" class="seg-tab">20 秒</button>
        <button type="button" role="radio" aria-checked="false" class="seg-tab">30 秒</button>
      </div>`,
  });
}

export async function post(feat) {
  if (feat === 'speed-setting' || feat === 'speed-dialog') return setting(feat === 'speed-dialog');
  await proxiesReady();
  if (feat === 'speed-menu') return menu();
  if (feat === 'speed-confirm') return confirm();
  if (feat === 'speed-run') return run();
  if (feat === 'speed-sort') return sort();
  return done();
}
