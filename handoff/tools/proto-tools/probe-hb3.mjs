import { chromium } from 'playwright';
const b = await chromium.launch();
for (const [proto,W,H] of [['homeb-top',930,680],['homeb-top',720,540]]) {
const p = await (await b.newContext({viewport:{width:W,height:H},locale:'zh-CN'})).newPage();
await p.goto('http://127.0.0.1:5174/index.html?home=minimal&theme=light&proto='+proto);
await p.waitForTimeout(2600);
await p.evaluate(async()=>{ if(window.__PROTO_POST__) await window.__PROTO_POST__(); });
await p.waitForTimeout(1000);
console.log(proto, await p.evaluate(()=>{const out=[];const walk=(e,d)=>{if(d>3)return;for(const c of e.children){const b=c.getBoundingClientRect();if(b.height<4)continue;out.push(' '.repeat(d)+(c.id||c.className.toString().split(' ').slice(0,2).join('.')).slice(0,40)+` y${Math.round(b.y)} h${Math.round(b.height)}`);walk(c,d+1)}};walk(document.querySelector('.home-hero-body'),0);return out.join('\n')}));
}
await b.close();
