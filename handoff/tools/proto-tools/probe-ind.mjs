import { chromium } from 'playwright';
const b = await chromium.launch();
for (const proto of ['', 'sidelabel-fold']) {
const p = await (await b.newContext({viewport:{width:720,height:540},locale:'zh-CN'})).newPage();
await p.goto('http://127.0.0.1:5174/index.html?home=console&theme=light'+(proto?'&proto='+proto:''));
await p.waitForTimeout(2600);
await p.evaluate(async()=>{ if(window.__PROTO_POST__) await window.__PROTO_POST__(); });
await p.waitForTimeout(900);
console.log(proto, await p.evaluate(()=>{const r=x=>{const b=x.getBoundingClientRect();return [Math.round(b.x),Math.round(b.y),Math.round(b.width),Math.round(b.height)]};const a=document.querySelector('#sidebar-nav .nav-btn.is-active');const i=document.querySelector('#sidebar-nav .nav-indicator');return JSON.stringify({a:r(a),i:r(i),it:i.style.cssText})}));
}
await b.close();
