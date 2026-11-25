import { chromium } from 'playwright';
const LANGX = process.env.LANGX || 'en';
const EXE = process.env.CHROME_PATH;
const browser = await chromium.launch({ executablePath: EXE });
for (const [w, h, theme] of [[930, 680, 'light'], [930, 680, 'dark'], [720, 540, 'light'], [1440, 900, 'light']]) {
  const ctx = await browser.newContext({ viewport: { width: w, height: h } });
  await ctx.addInitScript((l) => localStorage.setItem('lang', l), LANGX);
  const p = await ctx.newPage();
  p.on('pageerror', (e) => console.error('pageerror', e.message));
  await p.goto(`http://127.0.0.1:8811/index.html?theme=${theme}`);
  await p.waitForTimeout(2000);
  const r = await p.evaluate(() => {
    const nav = document.getElementById('sidebar-nav');
    const root = document.documentElement;
    const btns = [...nav.querySelectorAll('.nav-btn')].map((b) => {
      const r = b.getBoundingClientRect(); const l = b.querySelector('.nav-label'); const i = b.querySelector('svg');
      const ir = i?.getBoundingClientRect();
      return { nav: b.dataset.nav, x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height), iconX: ir && Math.round(ir.x), label: l?.textContent, op: l && getComputedStyle(l).opacity, trunc: l ? l.scrollWidth > l.clientWidth : null, color: getComputedStyle(b).color, active: b.classList.contains('is-active') };
    });
    const overlaps = [];
    for (let i = 0; i < btns.length; i++) for (let j = i + 1; j < btns.length; j++) { const a = btns[i], b = btns[j]; if (a.y < b.y + b.h && b.y < a.y + a.h) overlaps.push([a.nav, b.nav]); }
    const ind = document.querySelector('.nav-indicator');
    return { expanded: root.classList.contains('sidebar-expanded'), navW: Math.round(nav.getBoundingClientRect().width), lang: document.documentElement.lang, btns, overlaps, indicator: ind && { ...ind.getBoundingClientRect().toJSON(), bg: getComputedStyle(ind).backgroundColor }, mainX: Math.round(document.querySelector('main')?.getBoundingClientRect().x ?? -1) };
  });
  console.log(w, h, theme, JSON.stringify(r));
  if (w === 930 && theme === 'light') {
    await p.keyboard.press('Control+b'); await p.waitForTimeout(600);
    console.log('after Ctrl+B', await p.evaluate(() => [document.documentElement.classList.contains('sidebar-expanded'), Math.round(document.getElementById('sidebar-nav').getBoundingClientRect().width), [...document.querySelectorAll('.nav-btn svg')].map((s) => Math.round(s.getBoundingClientRect().x)).join(',')]));
    await p.screenshot({ path: (process.env.WORK || '.') + '/ui-pr-tools/out/new-collapsed-930-light.png' });
    await p.keyboard.press('Control+b'); await p.waitForTimeout(600);
    await p.click('#sidebar-nav', { button: 'right', position: { x: 40, y: 560 } });
    await p.waitForTimeout(300);
    console.log('menu', await p.evaluate(() => [...document.querySelectorAll('.sidebar-menu-item')].map((m) => m.textContent + ' ' + JSON.stringify(m.getBoundingClientRect()))));
    await p.keyboard.press('Escape');
    await p.click('.nav-btn[data-nav="subscriptions"]'); await p.waitForTimeout(1200);
    const btn = await p.evaluate(() => [...document.querySelectorAll('button')].filter((b) => b.offsetParent).map((b) => (b.getAttribute('aria-label') || b.title || b.textContent.trim()).slice(0, 30)).slice(0, 60));
    console.log('sub buttons', JSON.stringify(btn));
  }
  await ctx.close();
}
await browser.close();
