(() => {
  const c = document.querySelector('.dz-content');
  const r = (e) => { const b = e.getBoundingClientRect(); return `x${Math.round(b.x)} y${Math.round(b.y)} w${Math.round(b.width)} h${Math.round(b.height)}`; };
  const o = [`content ${r(c)} sh${c.scrollHeight} ch${c.clientHeight}`];
  for (const ch of c.children) { o.push(`${ch.tagName}.${ch.className.split(' ').slice(0,2).join('.')} ${r(ch)}`); if (/dz-grid|dz-side/.test(ch.className)) for (const g of ch.children) { o.push(`  ${g.id||g.className.split(' ').slice(0,2).join('.')} ${r(g)} sh${g.scrollHeight}`); if (/dz-side/.test(g.className)) for (const k of g.children) o.push(`    ${k.className.split(' ').slice(0,2).join('.')} ${r(k)} sh${k.scrollHeight}`); } }
  return o.join('\n');
})()
