import { chromium } from 'playwright';
const b = await chromium.launch();
const p = await (await b.newContext({viewport:{width:1100,height:900}})).newPage();
await p.goto('file://' + (process.env.WORK || process.cwd()) + '/zephyr-ui-prototypes.html'); await p.waitForTimeout(1500);
console.log(await p.evaluate(()=>{const bad=[...document.images].filter(i=>!i.naturalWidth).length;const t=document.querySelector('table.copy');const r=t.getBoundingClientRect();return `imgs ${document.images.length} broken ${bad} table ${Math.round(r.width)}x${Math.round(r.height)} scrollW ${t.parentElement.scrollWidth}/${t.parentElement.clientWidth}`}));
await b.close();
