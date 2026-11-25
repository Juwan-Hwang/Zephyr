(() => { const H = innerHeight; const r = (e) => { const b = e.getBoundingClientRect(); return `y${Math.round(b.top)}-${Math.round(b.bottom)} h${Math.round(b.height)}`; };
 const o = [`vh${H}`];
 const d = document.querySelector('.dz-content');
 if (d && d.offsetParent) { o.push(`dz sh${d.scrollHeight} ch${d.clientHeight}`); for (const s of ['#dz-traffic-card', '.dz-grid-bottom']) { const e = document.querySelector(s); o.push(s + ' ' + r(e)); }
   const avg = [...document.querySelectorAll('#dz-traffic-card *')].filter(e => !e.children.length && /1 分钟平均/.test(e.textContent)).pop(); if (avg) o.push('avg ' + r(avg));
   const btns = [...document.querySelectorAll('.dz-content button')].filter(b => /立即更新|管理订阅/.test(b.textContent)); for (const b of btns) o.push(b.textContent.trim() + ' ' + r(b));
   for (const c of document.querySelectorAll('.dz-content .glass-card')) if (c.offsetParent && c.scrollHeight > c.clientHeight + 2) o.push('CLIP ' + c.className.slice(0, 40)); }
 const p = document.querySelector('.fh-page'); if (p && p.offsetParent) { o.push('page ' + r(p)); for (const s of ['.fh-strip', '.fh-hero', '.fh-node']) o.push(s + ' ' + r(document.querySelector(s))); }
 return o.join(' | '); })()
