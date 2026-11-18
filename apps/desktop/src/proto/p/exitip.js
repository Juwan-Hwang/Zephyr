// #321 #673 显示出口 IP 和地区。设置里「显示出口 IP」开关（默认关），打开后自动查询，
// 切换节点时自动刷新，不再手动点「查询」。首页不再加胶囊，并进现有的一行：
//   ?proto=exitip-setting  设置 → 外观里的开关
//   ?proto=exitip-sub      方案一：节点名下面的副标题
//   ?proto=exitip-status   方案二：系统代理那一行的状态文字
//   ?proto=exitip-stats    方案三：统计行里多一项
// 控制台首页都先套方案 B（用户倾向的版本）。
import { $, html, until, ICONS, insertRowAfter, settingRow, toggle, scrollSettingsTo } from './_kit.js';
import { isConsole, consoleParts, applyConsoleB } from './_con.js';

const IP = '203.0.113.48';
const flag = '<span class="proto-exit-flag">🇭🇰</span>';
const ip = `<span class="proto-exit-ip">${IP}</span>`;

async function setting() {
  insertRowAfter('#setting-home-mode-container', settingRow({
    id: 'proto-exitip-row',
    iconPaths: ICONS.globe,
    title: '显示 IP 地址',
    desc: '打开后，首页会显示当前节点的 IP 地址和地区。',
    control: toggle(false),
  }));
  await scrollSettingsTo('#proto-exitip-row');
}

async function minimal(kind) {
  await until(() => $('#current-node-name') && $('#home-stats'));
  if (kind === 'sub') {
    // 节点胶囊下面一行小字，在布局里占一行，网速读数在剩下的空间里居中
    $('.home-hero-speeds').before(html(`<p class="proto-exit-line">${flag}<span>IP</span>${ip}<span class="proto-exit-dot">·</span><span>香港</span></p>`));
  } else if (kind === 'status') {
    const st = $('#proxy-status-text');
    // 原来是「已准备好保护您的流量」这类状态句，换成出口
    st.innerHTML = `${flag} IP ${ip}<span class="proto-exit-dot">·</span>香港`;
    st.classList.add('proto-exit-status');
  } else if (kind === 'stats') {
    const stats = $('#home-stats');
    stats.classList.add('proto-stats-4');
    stats.append(html(`<div class="home-stat">
      <span class="home-stat-label">IP 地址</span>
      <span class="home-stat-value"><b class="proto-exit-stat">${IP}</b></span>
      <span class="home-stat-foot">${flag} 香港</span>
    </div>`));
  }
  window.dispatchEvent(new Event('resize'));
}

async function consoleHome(kind) {
  const { nodeCard, traffic } = await consoleParts();
  await applyConsoleB();
  if (kind === 'sub') {
    // 「当前节点」卡：节点地址下面多一行副标题
    $('.dz-node-sub', nodeCard).after(html(`<div class="dz-node-sub proto-exit-consub">${flag}<span>IP</span>${ip}<span class="proto-exit-dot">·</span><span>香港</span></div>`));
  } else if (kind === 'status') {
    // 顶部开关条：系统代理那格的副标题从「127.0.0.1:7890」换成出口
    const sub = $('.proto-strip [data-c=sys] .proto-strip-sub');
    sub.innerHTML = `${flag} ${ip}`; // 窄窗口下这格只有约 100px，地区交给国旗
    sub.classList.add('proto-exit-status');
  } else if (kind === 'stats') {
    // 指标行：「节点延迟」那张卡的脚注从节点名换成出口（流量卡底部的统计行在默认窗口里看不到，不放那里）
    const lat = $('#dz-lat-val, [id^=dz-lat]')?.closest('.dz-kpi') || [...document.querySelectorAll('.dz-kpis > *')].pop();
    const foot = $('.dz-kpi-foot', lat);
    foot.dataset.protoWas = foot.textContent.trim();
    foot.innerHTML = `<span class="proto-exit-kpi">${flag} IP ${ip}</span>`;
  }
  window.dispatchEvent(new Event('resize'));
}

export async function post() {
  const kind = window.__PROTO__.replace(/^exitip-?/, '') || 'sub';
  if (kind === 'setting') return setting();
  if (isConsole()) return consoleHome(kind);
  return minimal(kind);
}
