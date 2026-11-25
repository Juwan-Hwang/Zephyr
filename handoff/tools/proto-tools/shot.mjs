// Usage: node shot.mjs <baseUrl> <outPng> [page] [extraScriptFile] [waitMs]
import { chromium } from 'playwright';
import fs from 'node:fs';

const [, , base, out, pageName = 'home', extra = '', waitMs = '3500'] = process.argv;
const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 860, height: 620 }, deviceScaleFactor: 1.5, locale: 'zh-CN', timezoneId: 'Asia/Shanghai', colorScheme: 'dark' });
const page = await ctx.newPage();
const logs = [];
page.on('console', (m) => { if (['error', 'warning'].includes(m.type())) logs.push(`[${m.type()}] ${m.text()}`); });
page.on('pageerror', (e) => logs.push(`[pageerror] ${e.message}`));
if (process.env.PRE) await page.addInitScript({ content: fs.readFileSync(process.env.PRE, 'utf8') });
await page.addInitScript({ path: new URL('./mock-tauri.js', import.meta.url).pathname });
await page.goto(base, { waitUntil: 'load' });
await page.waitForTimeout(2500);
if (pageName !== 'home') {
  await page.evaluate(async (p) => {
    const btn = document.querySelector(`[data-page="${p}"]`) || document.getElementById(`nav-${p}`);
    if (btn) btn.click();
  }, pageName);
}
if (extra) {
  const code = fs.readFileSync(extra, 'utf8');
  await page.evaluate(code);
}
await page.waitForTimeout(Number(waitMs));
await page.screenshot({ path: out });
if (process.env.LAYOUT) console.log(await page.evaluate(fs.readFileSync(new URL('./layout.js', import.meta.url).pathname, 'utf8')));
const mock = await page.evaluate(() => window.__MOCK_LOG__ || []);
if (process.env.VERBOSE) { console.log(logs.slice(0, 40).join('\n')); console.log([...new Set(mock)].join('\n')); }
await browser.close();
