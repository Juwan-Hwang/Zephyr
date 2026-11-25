// Usage: node batch.mjs jobs.json
// jobs: [{out, page?, proto?, pre?, post?, wait?, width?, height?, layout?}]
// pre: JS string run before app scripts (can set window.__PROTO_OVERRIDES__)
// post: JS string evaluated after app is up and page switched
import { chromium } from 'playwright';
import fs from 'node:fs';

const jobs = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
const BASE = process.env.BASE || 'http://127.0.0.1:5174/index.html';
const layoutJs = fs.readFileSync(new URL('./layout.js', import.meta.url).pathname, 'utf8');
const overlapJs = fs.readFileSync(new URL('./overlap.js', import.meta.url).pathname, 'utf8');
const browser = await chromium.launch({ args: ['--font-render-hinting=none'] });
const only = process.env.ONLY ? new RegExp(process.env.ONLY) : null;
for (const job of jobs) {
  if (only && !only.test(job.out)) continue;
  const W = job.home === 'minimal' || (!job.home && (!job.page || job.page === 'home')) ? 930 : 1082;
  const H = W === 930 ? 680 : 691;
  const ctx = await browser.newContext({ viewport: { width: job.width || W, height: job.height || H }, deviceScaleFactor: 2, locale: 'zh-CN', timezoneId: 'Asia/Shanghai', colorScheme: job.theme === 'dark' ? 'dark' : 'light', reducedMotion: 'no-preference' });
  const page = await ctx.newPage();
  const errs = [];
  page.on('pageerror', (e) => errs.push(`[pageerror] ${e.message}`));
  page.on('console', (m) => { if (m.type() === 'error' && process.env.VERBOSE && !m.text().includes('404')) errs.push(`[console] ${m.text().slice(0, 300)}`); });
  if (job.pre) await page.addInitScript({ content: job.pre });
  const qs = new URLSearchParams({ home: job.home || (job.page && job.page !== 'home' ? 'console' : 'minimal'), theme: job.theme || 'light' });
  if (job.proto) qs.set('proto', job.proto);
  await page.goto(BASE + '?' + qs, { waitUntil: 'load' });
  await page.waitForTimeout(2600);
  await page.evaluate('document.fonts.ready');
  await page.mouse.move((job.width || W) - 2, (job.height || H) - 2);

  if (job.page && job.page !== 'home') {
    await page.evaluate((p) => document.querySelector(`[data-nav="${p}"]`)?.click(), job.page);
    await page.waitForTimeout(1200);
  }
  await page.evaluate(async () => { if (window.__PROTO_POST__) await window.__PROTO_POST__(); }).catch((e) => errs.push(`[proto] ${e.message}`));
  if (job.post) {
    try { await page.evaluate(job.post); } catch (e) { errs.push(`[post] ${e.message}`); }
  }
  if (job.actions) {
    for (const a of job.actions) {
      if (a.click) await page.click(a.click, { timeout: 3000 }).catch((e) => errs.push(`[click] ${e.message.split('\n')[0]}`));
      if (a.hover) await page.hover(a.hover, { timeout: 3000, force: !!a.force }).catch((e) => errs.push(`[hover] ${e.message.split('\n')[0]}`));
      if (a.wait) await page.waitForTimeout(a.wait);
      if (a.eval) await page.evaluate(a.eval).catch((e) => errs.push(`[eval] ${e.message}`));
      if (a.mouse) await page.mouse.move(a.mouse[0], a.mouse[1]);
      if (a.press) await page.keyboard.press(a.press);
    }
  }
  await page.waitForTimeout(job.wait ?? 1800);
  await page.screenshot({ path: job.out, omitBackground: true, animations: 'disabled', caret: 'hide' });
  const sz = await page.evaluate(() => [innerWidth, innerHeight, devicePixelRatio]);
  console.log(`== ${job.out} ${sz.join('x')}${errs.length ? '\n' + errs.slice(0, 8).join('\n') : ''}`);
  if (process.env.PROBE) console.log(await page.evaluate(fs.readFileSync(process.env.PROBE, 'utf8')));
  if (job.overlap || process.env.OVERLAP) console.log('  overlap: ' + (await page.evaluate(overlapJs)).split('\n').join('\n  '));
  if (job.layout || process.env.LAYOUT) console.log(await page.evaluate(layoutJs));
  await ctx.close();
}
await browser.close();
