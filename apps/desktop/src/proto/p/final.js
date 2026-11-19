// 定稿原型：只包含选中的方案。?proto=final，由 window.__F__ 决定看哪一屏：
//   __F__.feat  — home（默认，按 ?home= 走简洁或控制台）、coredown、speed-*、
//                或者一个已有原型名（bypass-dialog、cards-200、privnet-after …）
//   __F__.ip    — 「显示 IP 地址」打开
// 所有屏都套定稿外壳：纯文字侧栏（sidetext）+ 辅助文字对比度修正（final.css）+ 简洁首页随窗口缩放的规则（fsize.css）。
import { $, $$, html, icon, ICONS, until, wait } from './_kit.js';

const F = (window.__F__ = window.__F__ || {});
const feat = F.feat || 'home';
const isConsole = () => new URLSearchParams(location.search).get('home') === 'console';

function css(name) {
  if (document.querySelector(`link[data-f="${name}"]`)) return Promise.resolve();
  const l = document.createElement('link');
  l.rel = 'stylesheet';
  l.href = `proto/p/${name}.css`;
  l.dataset.f = name;
  const p = new Promise((r) => { l.onload = r; l.onerror = r; });
  document.head.appendChild(l);
  return p;
}
const modName = (n) => n.replace(/-.*$/, '');
async function load(n) {
  try { return await import(`./${n}.js`); } catch { return import(`./${modName(n)}.js`); }
}
const SPEED = feat.startsWith('speed-');
const OWN = ['home', 'coredown', 'exitip-setting'];

export async function pre() {
  await css('sidetext');
  await css('homeb');
  await css('choice');
  await css('speedtest');
  await css('exitip');
  // final.css 最后再加一次，保证压在各原型样式上面
  if (feat === 'coredown') { await css('coredown'); window.__PROTO_TRAFFIC_ZERO__ = true; }
  if (!OWN.includes(feat) && !SPEED) {
    await css(modName(feat));
    const m = await load(feat);
    window.__PROTO__ = feat;
    if (m.pre) await m.pre();
    window.__PROTO__ = 'final';
  }
  if (SPEED && feat !== 'speed-setting' && feat !== 'speed-dialog') {
    const { renameNodes, LONG_NAMES } = await import('./_proxies.js');
    const st = document.createElement('style');
    st.textContent = '#proxies-list { grid-template-columns: repeat(auto-fill, minmax(200px, 1fr)) !important; }';
    document.head.appendChild(st);
    void renameNodes; void LONG_NAMES;
  }
  const again = document.createElement('link');
  again.rel = 'stylesheet';
  again.href = 'proto/p/final.css?late';
  document.head.appendChild(again);
  const size = document.createElement('link');
  size.rel = 'stylesheet';
  size.href = 'proto/p/fsize.css';
  document.head.appendChild(size);
}

// 文案：「测速地址」和新的「下载测速」放在一起会分不清，改叫「延迟测试地址」
function renameTestUrl() {
  for (const e of $$('#proto-testurl-row p, .proto-dialog .dialog-title')) {
    if (e.textContent.trim() === '测速地址') e.textContent = '延迟测试地址';
  }
}

async function consoleHome() {
  const { applyConsoleB, consoleParts } = await import('./_con.js');
  const parts = await consoleParts();
  const { nodeCard, kpis } = parts;
  await applyConsoleB();
  const { nodeSub, ALTS, stateSub } = await import('./fhome.js');
  // 开关条副标题：端口号是实现细节，换成状态
  const sys = $('.proto-strip [data-c=sys] .proto-strip-sub');
  if (sys) sys.textContent = stateSub(!!$('#dz-sys-toggle')?.checked);
  // 「当前节点」卡：打开显示 IP 后，节点名下面一行 IP 和地区；卡片底部列出延迟较低的节点
  if (F.ip) {
    const name = $('#dz-node-name').closest('.dz-node-name-row') || $('#dz-node-name');
    name.after(html(`<div class="dz-node-sub fh-sub fc-ip">${nodeSub({ ip: true }).replace(/^.*?<\/span><span class="fh-sep">·<\/span>/, '')}</div>`));
  }
  nodeCard.append(html(`<div class="fc-node-alts"><p>延迟较低</p>${ALTS.slice(0, 3).map(([f, n, ms]) => `<button type="button" class="fc-alt" title="切换到 ${n}"><span class="fh-alt-flag">${f}</span><span class="fh-alt-name">${n}</span><span class="fh-alt-ms">${ms} ms</span></button>`).join('')}</div>`));
  // 「节点延迟」和「当前节点」卡里的延迟重复，去掉；剩下 4 张指标卡，1082 宽时不再截断「总流量」的脚注
  const lat = [...kpis.children].find((k) => /节点延迟/.test(k.textContent));
  if (lat) lat.remove();
  // 「活动连接」指标卡本身就是进入连接页的入口
  const conn = [...kpis.children].find((k) => /活动连接/.test(k.textContent));
  if (conn) {
    conn.classList.add('fc-kpi-link');
    conn.setAttribute('role', 'link');
    conn.setAttribute('tabindex', '0');
    conn.setAttribute('aria-label', '活动连接 12 个，查看连接');
    const lab = conn.querySelector('.dz-kpi-label');
    lab?.append(html(`<span class="fc-kpi-arrow">${icon('<path d="m9 18 6-6-6-6"/>', 'w-3.5 h-3.5')}</span>`));
  }
  consoleFit(parts);
  window.dispatchEvent(new Event('resize'));
}

// 控制台首页随窗口缩放（规则见 fsize.css）：
// 宽窗口（≥ 1081 px）下订阅卡回到底行，和「活动连接」「最近事件」并排，右栏只留「当前节点」，
// 「实时流量」不再被右栏两张卡撑高；窄窗口照旧放在「当前节点」下面。
// 「延迟较低」能放几个放几个（1–3 个），放不下的那一行整行藏起来，不露半行。
function consoleFit({ side, subCard, bottom, nodeCard }) {
  const mq = matchMedia('(min-width: 1081px)');
  const place = () => {
    if (mq.matches) { bottom.append(subCard); subCard.style.flex = ''; }
    else { side.append(subCard); subCard.style.flex = '1'; }
    document.documentElement.classList.toggle('fc-wide', mq.matches);
  };
  place();
  mq.addEventListener('change', place);
  const fitAlts = () => {
    const alts = [...nodeCard.querySelectorAll('.fc-alt')];
    alts.forEach((a) => { a.hidden = false; });
    if (!document.documentElement.classList.contains('fc-wide')) return;
    for (let i = alts.length - 1; i > 0 && nodeCard.scrollHeight > nodeCard.clientHeight + 1; i--) alts[i].hidden = true;
  };
  new ResizeObserver(() => requestAnimationFrame(fitAlts)).observe(nodeCard);
  fitAlts();
}

async function home() {
  if (isConsole()) return consoleHome();
  const { post } = await import('./fhome.js');
  return post(F);
}

async function coredown() {
  await home();
  const banner = html(`<div class="proto-core-banner glass-card relative z-20 shrink-0" role="alert">
    <span class="proto-core-banner-icon">${icon(ICONS.alert, 'w-4 h-4')}</span>
    <div class="min-w-0 flex-1">
      <p class="proto-core-banner-title">内核已停止运行</p>
      <p class="proto-core-banner-desc">重新启动前将无法连接互联网。</p>
    </div>
    <div class="flex items-center gap-2 shrink-0">
      <button type="button" class="btn-ghost text-xs px-3 py-1.5">关闭系统代理</button>
      <button type="button" class="btn-primary text-xs px-3.5 py-1.5 flex items-center gap-1.5">${icon(ICONS.refresh, 'w-3.5 h-3.5')}重新启动</button>
    </div>
  </div>`);
  if (isConsole()) {
    $('.proto-strip-top').before(banner);
    $('#dz-node-name').textContent = '已停止';
    return;
  }
  $('[data-page="home"]').prepend(banner);
  const bar = $('.fh-node');
  bar.classList.add('is-stopped');
  bar.querySelector('.fh-sub').innerHTML = '<span class="fh-ms"><i class="fh-dot"></i>已停止</span>';
  window.dispatchEvent(new Event('resize'));
}

export async function post() {
  const side = await import('./sidetext.js');
  await side.post();
  await wait(50);
  if (feat === 'home') await home();
  else if (feat === 'coredown') await coredown();
  else if (SPEED) {
    if (feat === 'speed-setting' || feat === 'speed-dialog') {
      const t = await import('./testurl.js');
      await t.post();
    }
    const s = await import('./fspeed.js');
    await s.post(feat);
  } else if (feat === 'exitip-setting') {
    window.__PROTO__ = 'exitip-setting';
    await (await import('./exitip.js')).post();
  } else {
    const m = await load(feat);
    window.__PROTO__ = feat;
    await m.post?.();
  }
  window.__PROTO__ = 'final';
  renameTestUrl();
  await wait(100);
  window.dispatchEvent(new Event('resize'));
}
