import { chromium } from 'playwright';
import fs from 'node:fs';
const theme = process.argv[2] || 'light';
const b = await chromium.launch();
const ctx = await b.newContext({ viewport: { width: 1082, height: 691 }, deviceScaleFactor: 1, locale: 'zh-CN', colorScheme: theme });
const p = await ctx.newPage();
await p.addInitScript(() => { window.__PROTO_SIDE__ = 'expanded'; });
await p.goto(`http://127.0.0.1:5174/index.html?home=console&theme=${theme}&proto=sidelabel-fold`);
await p.waitForTimeout(2600);
await p.evaluate(async () => { if (window.__PROTO_POST__) await window.__PROTO_POST__(); });
await p.waitForTimeout(1200);
await p.mouse.move(1080, 689);
const cdp = await ctx.newCDPSession(p);
await cdp.send('Animation.enable');
const dir = `rec-${theme}`; fs.rmSync(dir, { recursive: true, force: true }); fs.mkdirSync(dir);
const clip = { x: 0, y: 0, width: 560, height: 420 };
let n = 0; const times = [];
const shot = async () => { const t = await p.evaluate(() => { const n = document.querySelector('#sidebar-nav'); return n.getBoundingClientRect().width.toFixed(1) + '/' + getComputedStyle(n.querySelector('.proto-nav-label')).opacity.slice(0, 4); }); await p.screenshot({ path: `${dir}/${String(n++).padStart(3, '0')}.png`, clip }); times.push(t); };
for (let i = 0; i < 4; i++) await shot();
for (const _ of [0, 1]) {
  await cdp.send('Animation.setPlaybackRate', { playbackRate: 0.1 });
  const t0 = performance.now();
  await p.evaluate(() => document.querySelector('#proto-side-toggle').click());
  while (performance.now() - t0 < 3300) await shot();
  await cdp.send('Animation.setPlaybackRate', { playbackRate: 1 });
  await p.waitForTimeout(400);
  for (let i = 0; i < 6; i++) await shot();
}
fs.writeFileSync(`${dir}/times.json`, JSON.stringify(times));
console.log('frames', n, 'avg gap', ((times.at(-1) - times[0]) / n).toFixed(0));
// 过渡中间一帧（2x）：展开到一半
const p2 = await (await b.newContext({ viewport: { width: 1082, height: 691 }, deviceScaleFactor: 2, locale: 'zh-CN', colorScheme: theme })).newPage();
await p2.addInitScript(() => { window.__PROTO_SIDE__ = 'collapsed'; });
await p2.goto(`http://127.0.0.1:5174/index.html?home=console&theme=${theme}&proto=sidelabel-fold`);
await p2.waitForTimeout(2600);
await p2.evaluate(async () => { if (window.__PROTO_POST__) await window.__PROTO_POST__(); });
await p2.waitForTimeout(1000);
await p2.mouse.move(1080, 689);
const c2 = await p2.context().newCDPSession(p2); await c2.send('Animation.enable');
await c2.send('Animation.setPlaybackRate', { playbackRate: 0.02 });
await p2.evaluate(() => document.querySelector('#proto-side-toggle').click());
await p2.waitForTimeout(4600); // ≈92ms 动画时间：宽度过了一半多，文字刚开始淡入
console.log(await p2.evaluate(() => { const n = document.querySelector('#sidebar-nav'); const l = n.querySelector('.proto-nav-label'); return 'mid width ' + n.getBoundingClientRect().width + ' label op ' + getComputedStyle(l).opacity; }));
await p2.screenshot({ path: `out/side-fold-mid${theme === 'dark' ? '-dark' : ''}.png` });
await b.close();
