import { chromium } from 'playwright';
const b = await chromium.launch();
for (const [proto,W,H] of [['homeb',930,680],['homeb-top',930,680],['homeb-top-bottom',930,680],['homeb-top',720,540],['homeb-top-bottom',720,540]]) {
const p = await (await b.newContext({viewport:{width:W,height:H},locale:'zh-CN'})).newPage();
await p.goto('http://127.0.0.1:5174/index.html?home=minimal&theme=light&proto='+proto);
await p.waitForTimeout(2600);
await p.evaluate(async()=>{ if(window.__PROTO_POST__) await window.__PROTO_POST__(); });
await p.waitForTimeout(1000);
console.log(proto,W,H, await p.evaluate(()=>{const r=x=>{if(!x)return null;const b=x.getBoundingClientRect();return [Math.round(b.y),Math.round(b.height)]};
const pg=document.querySelector('[data-page="home"]'); const h=document.querySelector('#home-hero');
const kids=[...h.children].map(c=>(c.className||c.id).toString().split(' ')[0].slice(0,24)+':'+r(c)).join(' ');
const t=document.querySelector('.proto-top'); const items=t?t.querySelectorAll('.proto-top-item, button, .item').length:0;
return `scroll ${pg.scrollHeight}/${pg.clientHeight} strip ${r(document.querySelector('.proto-hb-strip, .hb-strip, [class*=strip]'))} top ${r(t)} items ${items} hero ${r(h)} kids ${kids}`}));
}
await b.close();
