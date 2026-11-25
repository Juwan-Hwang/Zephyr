import { chromium } from 'playwright';
const b = await chromium.launch();
for (const proto of ['', 'sidelabel-fold']) {
const p = await (await b.newContext({viewport:{width:720,height:540},locale:'zh-CN'})).newPage();
await p.goto('http://127.0.0.1:5174/index.html?home=console&theme=light'+(proto?'&proto='+proto:''));
await p.waitForTimeout(2600);
await p.evaluate(async()=>{ if(window.__PROTO_POST__) await window.__PROTO_POST__(); });
await p.waitForTimeout(600);
console.log(proto, await p.evaluate(()=>{const n=document.querySelector('#sidebar-nav');const cs=getComputedStyle(n);return cs.gap+' pad '+cs.padding+' just '+cs.justifyContent+'\n'+[...n.children].map(c=>{const b=c.getBoundingClientRect(),s=getComputedStyle(c);return (c.dataset.nav||c.id||c.className).toString().slice(0,30)+' y'+Math.round(b.y)+' h'+Math.round(b.height)+' fl:'+s.flex+' mh:'+s.minHeight+' mt:'+s.marginTop}).join('\n')}));
}
await b.close();
