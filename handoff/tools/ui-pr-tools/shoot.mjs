// Screenshot harness: node shoot.mjs <port> <outdir> <tag>
import { chromium } from 'playwright';
const [port, out, tag] = process.argv.slice(2);
const base = `http://127.0.0.1:${port}/index.html`;
const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH });

async function page(w, h, theme, lang = 'zh') {
  const ctx = await browser.newContext({ viewport: { width: w, height: h }, deviceScaleFactor: 2, locale: 'zh-CN' });
  await ctx.addInitScript((l) => { try { localStorage.setItem('language', l); localStorage.setItem('lang', l); } catch {} }, lang);
  const p = await ctx.newPage();
  p.on('pageerror', (e) => console.error('pageerror', e.message));
  await p.goto(`${base}?theme=${theme}&home=minimal`);
  await p.waitForTimeout(2500);
  return p;
}

const shots = [];
for (const theme of ['light', 'dark']) {
  const p = await page(930, 680, theme);
  await p.screenshot({ path: `${out}/${tag}-home-930-${theme}.png` });
  shots.push(`${tag}-home-930-${theme}`);
  // proxies page
  await p.click('.nav-btn[data-nav="proxies"]').catch((e) => console.error(e.message));
  await p.waitForTimeout(1500);
  await p.screenshot({ path: `${out}/${tag}-proxies-930-${theme}.png` });
  // sidebar context menu
  if (theme === 'light') {
    await p.click('#sidebar-nav', { button: 'right', position: { x: 40, y: 500 } }).catch(() => {});
    await p.waitForTimeout(400);
    await p.screenshot({ path: `${out}/${tag}-menu-930-${theme}.png`, clip: { x: 0, y: 380, width: 360, height: 220 } });
    await p.keyboard.press('Escape');
  }
  if (tag === 'new') {
    await p.click('.nav-btn[data-nav="home"]'); await p.keyboard.press('Control+b'); await p.waitForTimeout(700);
    await p.screenshot({ path: `${out}/${tag}-collapsed-930-${theme}.png` });
  }
  await p.context().close();
}
// narrow window
const n = await page(720, 540, 'light');
await n.screenshot({ path: `${out}/${tag}-home-720-light.png` });
await n.context().close();
// subscription edit dialog
const s = await page(930, 680, 'light');
await s.evaluate(() => { const b = [...document.querySelectorAll('.nav-btn')].find((x) => /sub/i.test(x.dataset.nav || "")); b?.click(); });
await s.waitForTimeout(1500);
await s.screenshot({ path: `${out}/${tag}-subs-930-light.png` });
const edit = await s.$('[data-action="edit"], .sub-edit-btn, button[title*="编辑"]');
if (edit) { await edit.click(); await s.waitForTimeout(1000); await s.screenshot({ path: `${out}/${tag}-subedit-930-light.png` }); }
else console.error('no edit button');
await s.context().close();
await browser.close();
console.log('done');
