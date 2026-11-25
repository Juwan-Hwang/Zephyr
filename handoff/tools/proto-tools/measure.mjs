import { chromium } from 'playwright';
const b = await chromium.launch();
for (const proto of ['homeb-top','homeb-top-bottom']) {
  const p = await (await b.newContext({viewport:{width:930,height:680},locale:'zh-CN'})).newPage();
  await p.goto('http://127.0.0.1:5174/index.html?home=minimal&theme=light&proto='+proto);
  await p.waitForTimeout(2600);
  await p.evaluate(async()=>{ if(window.__PROTO_POST__) await window.__PROTO_POST__(); });
  await p.waitForTimeout(1500);
  const r = await p.evaluate(()=>{
    const pg=document.querySelector('[data-page="home"]');const pr=pg.getBoundingClientRect();
    const out=[['page',Math.round(pr.top),Math.round(pr.bottom)]];
    for(const c of pg.children){ if(getComputedStyle(c).display==='none')continue; const r=c.getBoundingClientRect(); out.push([c.className.split(' ').slice(0,3).join('.')||c.id, Math.round(r.top),Math.round(r.bottom)]);}
    const hb=document.querySelector('#home-hero .home-hero-body');
    if(hb){const kids=[...hb.querySelectorAll(':scope > *')].map(k=>{const r=k.getBoundingClientRect();return [k.className.split(' ')[0],Math.round(r.top),Math.round(r.bottom)]});out.push(['hero-body-kids',kids]);}
    return out;});
  console.log(proto, JSON.stringify(r));
}
await b.close();
