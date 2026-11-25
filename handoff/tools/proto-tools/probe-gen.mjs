import { chromium } from 'playwright';
const [proto,page,W,H,theme,sel]=[process.argv[2],process.argv[3]||'',+process.argv[4]||1082,+process.argv[5]||691,process.argv[6]||'light',process.argv[7]||'body'];
const b = await chromium.launch();
const p = await (await b.newContext({viewport:{width:W,height:H},locale:'zh-CN'})).newPage();
p.on('pageerror',e=>console.log('ERR',e.message));
await p.goto(`http://127.0.0.1:5174/index.html?home=${page&&page!=='home'?'console':'minimal'}&theme=${theme}&proto=${proto}`);
await p.waitForTimeout(2600);
if(page&&page!=='home'){await p.evaluate(x=>document.querySelector(`[data-nav="${x}"]`)?.click(),page);await p.waitForTimeout(1200);}
await p.evaluate(async()=>{ if(window.__PROTO_POST__) await window.__PROTO_POST__(); });
await p.waitForTimeout(600);
console.log(await p.evaluate((sel)=>{const out=[];const roots=[...document.querySelectorAll(sel)];
for(const root of roots){const rb=root.getBoundingClientRect();out.push(`ROOT ${sel} [${Math.round(rb.x)},${Math.round(rb.y)},${Math.round(rb.width)}x${Math.round(rb.height)}] vp ${innerWidth}x${innerHeight}`);
for(const e of root.querySelectorAll('*')){const own=[...e.childNodes].filter(n=>n.nodeType===3&&n.textContent.trim()).map(n=>n.textContent.trim()).join(' ');if(!own)continue;const r=e.getBoundingClientRect();if(!r.width)continue;const trunc=e.scrollWidth>e.clientWidth+1&&getComputedStyle(e).overflow!=='visible';out.push(`${trunc?'TRUNC ':''}[${Math.round(r.x)},${Math.round(r.y)},${Math.round(r.width)}x${Math.round(r.height)}] ${own.slice(0,70)}`)}}
return out.join('\n')},sel));
await b.close();
