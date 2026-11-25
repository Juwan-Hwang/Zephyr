import { chromium } from 'playwright';
const b = await chromium.launch();
const proto = process.argv[2]||'homeb-top-bottom'; const W=+process.argv[3]||930, H=+process.argv[4]||680;
const p = await (await b.newContext({viewport:{width:W,height:H},locale:'zh-CN'})).newPage();
await p.goto('http://127.0.0.1:5174/index.html?home=minimal&theme=light&proto='+proto);
await p.waitForTimeout(2600);
await p.evaluate(async()=>{ if(window.__PROTO_POST__) await window.__PROTO_POST__(); });
await p.waitForTimeout(1200);
console.log(await p.evaluate(()=>{
 const t=document.querySelector('.proto-top'); const pg=document.querySelector('[data-page="home"]');
 const cs=getComputedStyle(pg); const h=document.querySelector('#home-hero'); const hcs=getComputedStyle(h);
 const o={topParent:t&&t.parentElement.className, topRect:t&&JSON.stringify(t.getBoundingClientRect()), pgDisplay:cs.display, pgFlex:cs.flexDirection, pgOverflow:cs.overflow, pgH:pg.scrollHeight+'/'+pg.clientHeight, heroFlex:hcs.flex, heroMinH:hcs.minHeight, heroH:h.getBoundingClientRect().height, pgClass:pg.className, heroClass:h.className, chart:document.querySelector('.home-hero-chart')?.className};
 return JSON.stringify(o,null,1);}));
await b.close();
